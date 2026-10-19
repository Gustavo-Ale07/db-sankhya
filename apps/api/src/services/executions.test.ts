import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import { ExecutionRegistry } from './executions';

describe('ExecutionRegistry', () => {
  it('caps concurrent executions per user, not globally', () => {
    const registry = new ExecutionRegistry();
    for (let i = 0; i < ExecutionRegistry.MAX_PER_USER; i++) registry.start(`a${i}`, 'alice');
    let code: string | undefined;
    try {
      registry.start('a-extra', 'alice');
    } catch (err) {
      if (isAppError(err)) code = err.code;
    }
    expect(code).toBe('RATE_LIMITED');
    expect(() => registry.start('b0', 'bob')).not.toThrow();
    registry.finish('a0');
    expect(() => registry.start('a-extra', 'alice')).not.toThrow();
  });

  it('only lets the owner or an admin cancel', () => {
    const registry = new ExecutionRegistry();
    const controller = registry.start('x', 'alice');
    expect(registry.cancel('x', 'bob', false)).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    expect(registry.cancel('x', 'bob', true)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });
});
