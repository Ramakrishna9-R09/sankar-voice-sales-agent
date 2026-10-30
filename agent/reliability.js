export class CircuitOpenError extends Error {
  constructor(retryAt) {
    super('The AI provider is cooling down after repeated failures. Please try again shortly.');
    this.name = 'CircuitOpenError';
    this.status = 503;
    this.retryAt = retryAt;
  }
}

export class CircuitBreaker {
  constructor({ threshold = 4, cooldownMs = 20_000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.failures = 0;
    this.openUntil = 0;
    this.probeInProgress = false;
  }
  get state() {
    if (this.openUntil > this.now()) return 'open';
    if (this.openUntil) return 'half-open';
    return 'closed';
  }
  assertAvailable() {
    if (this.openUntil > this.now()) throw new CircuitOpenError(this.openUntil);
    if (this.openUntil && this.probeInProgress) throw new CircuitOpenError(this.openUntil);
    if (this.openUntil) this.probeInProgress = true;
  }
  success() { this.failures = 0; this.openUntil = 0; this.probeInProgress = false; }
  failure() {
    this.failures += 1;
    this.probeInProgress = false;
    if (this.failures >= this.threshold) this.openUntil = this.now() + this.cooldownMs;
  }
  snapshot() { return { state: this.state, failures: this.failures, retry_in_ms: Math.max(0, this.openUntil - this.now()) }; }
}

const transient = (error) => error?.name === 'TimeoutError' || error?.name === 'TypeError' || [408, 425, 429, 500, 502, 503, 504].includes(error?.status);

export async function retryTransient(operation, { retries = 2, signal, onRetry = () => {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    try { return await operation(attempt); }
    catch (error) {
      lastError = error;
      if (attempt >= retries || !transient(error) || error?.name === 'AbortError') throw error;
      onRetry(attempt + 1, error);
      const exponential = Math.min(2200, 250 * (2 ** attempt));
      const jitter = Math.floor(Math.random() * 120);
      const wait = Math.max(exponential + jitter, Math.min(3000, error.retryAfterMs || 0));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }
  }
  throw lastError;
}

