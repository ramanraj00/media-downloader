import Redis from 'ioredis';
import { CircuitState } from './circuitBreaker';
import { CircuitBreakerOpenError } from './errors';
import crypto from 'crypto';

export interface DistributedCircuitBreakerConfig {
  redisUrl: string;
  name: string;
  failureThreshold: number;
  resetTimeoutMs: number;
}

export class DistributedCircuitBreaker {
  private redis: Redis;
  private name: string;
  private failureThreshold: number;
  private resetTimeoutMs: number;

  constructor(config: DistributedCircuitBreakerConfig) {
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    this.name = config.name;
    this.failureThreshold = config.failureThreshold;
    this.resetTimeoutMs = config.resetTimeoutMs;
  }

  public async execute<T>(action: () => Promise<T>, shouldTrip?: (err: Error) => boolean): Promise<T> {
    const stateKey = `cb:${this.name}:state`;
    const failuresKey = `cb:${this.name}:failures`;
    const lastFailureKey = `cb:${this.name}:last_failure`;
    const halfOpenLockKey = `cb:${this.name}:half_open_lock`;

    let currentState = (await this.redis.get(stateKey)) as CircuitState || CircuitState.CLOSED;
    const lastFailureRaw = await this.redis.get(lastFailureKey);
    const lastFailureTime = lastFailureRaw ? parseInt(lastFailureRaw, 10) : 0;
    const now = Date.now();

    let halfOpenToken: string | null = null;

    if (currentState === CircuitState.OPEN) {
      if (now - lastFailureTime > this.resetTimeoutMs) {
        // Attempt to transition to HALF_OPEN by acquiring atomic single-probe mutex lock
        const token = crypto.randomUUID();
        const probeAcquired = await this.redis.set(halfOpenLockKey, token, 'PX', 10000, 'NX');

        if (probeAcquired) {
          currentState = CircuitState.HALF_OPEN;
          halfOpenToken = token;
          await this.redis.set(stateKey, CircuitState.HALF_OPEN);
        } else {
          throw new CircuitBreakerOpenError(`Circuit Breaker [${this.name}] is OPEN (Another HALF_OPEN probe in progress)`, this.name);
        }
      } else {
        throw new CircuitBreakerOpenError(`Circuit Breaker [${this.name}] is OPEN`, this.name);
      }
    }

    try {
      const result = await action();
      await this.onSuccess(stateKey, failuresKey, halfOpenLockKey, halfOpenToken);
      return result;
    } catch (error: any) {
      if (shouldTrip ? shouldTrip(error) : true) {
        await this.onFailure(stateKey, failuresKey, lastFailureKey, halfOpenLockKey, halfOpenToken);
      } else {
        // Still register success to clear half-open states since this wasn't a catastrophic API failure
        await this.onSuccess(stateKey, failuresKey, halfOpenLockKey, halfOpenToken);
      }
      throw error;
    }
  }

  private async onSuccess(stateKey: string, failuresKey: string, halfOpenLockKey: string, halfOpenToken: string | null) {
    const pipeline = this.redis.pipeline();
    pipeline.set(stateKey, CircuitState.CLOSED);
    pipeline.set(failuresKey, '0');
    if (halfOpenToken) {
      pipeline.del(halfOpenLockKey);
    }
    await pipeline.exec();
  }

  private async onFailure(stateKey: string, failuresKey: string, lastFailureKey: string, halfOpenLockKey: string, halfOpenToken: string | null) {
    const now = Date.now();
    const failures = await this.redis.incr(failuresKey);
    await this.redis.set(lastFailureKey, now.toString());

    if (failures >= this.failureThreshold || halfOpenToken !== null) {
      await this.redis.set(stateKey, CircuitState.OPEN);
    }

    if (halfOpenToken) {
      await this.redis.del(halfOpenLockKey);
    }
  }

  public async getState(): Promise<CircuitState> {
    const stateKey = `cb:${this.name}:state`;
    return ((await this.redis.get(stateKey)) as CircuitState) || CircuitState.CLOSED;
  }

  public async reset(): Promise<void> {
    const stateKey = `cb:${this.name}:state`;
    const failuresKey = `cb:${this.name}:failures`;
    const lastFailureKey = `cb:${this.name}:last_failure`;
    const halfOpenLockKey = `cb:${this.name}:half_open_lock`;

    await this.redis.del(stateKey, failuresKey, lastFailureKey, halfOpenLockKey);
  }

  public async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
