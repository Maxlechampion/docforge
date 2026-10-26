/**
 * Circuit breaker partagé (opossum).
 * Utilisé pour protéger tout appel inter-modules ou service externe.
 * Cf. contrainte 0.2 §4.3.3.
 */
import CircuitBreaker from 'opossum';

export function createBreaker(fn, options = {}) {
  const breaker = new CircuitBreaker(fn, {
    timeout: options.timeout ?? 15000,
    errorThresholdPercentage: options.errorThresholdPercentage ?? 50,
    resetTimeout: options.resetTimeout ?? 30000,
    ...options,
  });
  breaker.on('open', () => console.warn('[breaker] OPEN'));
  breaker.on('halfOpen', () => console.warn('[breaker] HALF-OPEN'));
  breaker.on('close', () => console.info('[breaker] CLOSED'));
  return breaker;
}
