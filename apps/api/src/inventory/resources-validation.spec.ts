import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { searchQuerySchema } from './resources.controller';

/*
 * How a bad resource search is REJECTED (ADR-0025 §10).
 *
 * Every case here must be a 400 naming the field. The first version answered
 * `type=file` — an operator forgetting one capital letter — with a 500, because
 * the schema called `.parse()` inside a `.transform()` and the throw escaped the
 * validation pipe. A 500 on user input reads as a broken server and is escalated
 * as one, which is a support call for a typo.
 */

const pipe = new ZodValidationPipe(searchQuerySchema);

describe('resource search validation', () => {
  const rejects = (query: Record<string, unknown>) => () => pipe.transform(query);

  it('rejects a search with no type at all', () => {
    expect(rejects({ title: '/etc/motd' })).toThrow(BadRequestException);
  });

  /*
   * THE 500. A resource type is capitalised; `file` is a typo, not a fault.
   */
  it('rejects a lowercase type as a 400, never a 500', () => {
    expect(rejects({ type: 'file' })).toThrow(BadRequestException);
  });

  it('rejects a type that is not a resource type', () => {
    expect(rejects({ type: 'File; DROP' })).toThrow(BadRequestException);
    expect(rejects({ type: '' })).toThrow(BadRequestException);
  });

  it('rejects malformed filter JSON', () => {
    expect(rejects({ type: 'File', facts: 'not-json' })).toThrow(BadRequestException);
    expect(rejects({ type: 'File', parameters: '{}' })).toThrow(BadRequestException);
  });

  it('accepts a valid search and yields a typed filter', () => {
    const filter = pipe.transform({
      type: 'File',
      title: '/etc/motd',
      environments: 'production,staging',
    });

    expect(filter).toEqual({
      type: 'File',
      title: '/etc/motd',
      environments: ['production', 'staging'],
    });
  });

  it('accepts a namespaced type', () => {
    expect(pipe.transform({ type: 'Nginx::Config' }).type).toBe('Nginx::Config');
  });
});
