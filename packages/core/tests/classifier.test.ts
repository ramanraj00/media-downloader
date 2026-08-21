import { classifyPlatformError, buildAppError } from '../src/classifiers';
import { CredentialAction } from '../src/classifiers/types';
import { AppError } from '../src/errors';
import { Platform } from '@media-downloader/types';
import assert from 'assert';

let passed = 0;
let failed = 0;

function it(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`❌ ${name}`);
    console.error(err);
    failed++;
  }
}

async function runTests() {
  console.log('--- Error Classifier Matrix Tests ---');

  it('classifies explicit Rate Limit with Retry-After', () => {
    const result = classifyPlatformError('HTTP Error 429: Too Many Requests\nRetry-After: 120', Platform.INSTAGRAM);
    assert.strictEqual(result.errorType, 'rate_limit');
    assert.strictEqual(result.credentialAction, CredentialAction.COOLDOWN);
    assert.strictEqual(result.retryable, true);
    assert.strictEqual(result.retryAfterMs, 120000);
    
    const error = buildAppError(result, Platform.INSTAGRAM);
    assert.strictEqual(error.credentialAction, CredentialAction.COOLDOWN);
  });

  it('classifies explicit Anti-bot (Instagram)', () => {
    const result = classifyPlatformError('403 + challenge_required', Platform.INSTAGRAM);
    assert.strictEqual(result.errorType, 'identity_blocked');
    assert.strictEqual(result.credentialAction, CredentialAction.BLOCK);
    assert.strictEqual(result.retryable, true);
  });

  it('does NOT block on ambiguous 403', () => {
    const result = classifyPlatformError('HTTP Error 403: Forbidden', Platform.INSTAGRAM);
    assert.notStrictEqual(result.credentialAction, CredentialAction.BLOCK);
    assert.strictEqual(result.credentialAction, CredentialAction.COOLDOWN);
    assert.strictEqual(result.errorType, 'transient');
  });

  it('does NOT block on ambiguous access denied', () => {
    const result = classifyPlatformError('Access Denied', Platform.YOUTUBE);
    assert.notStrictEqual(result.credentialAction, CredentialAction.BLOCK);
    assert.strictEqual(result.credentialAction, CredentialAction.COOLDOWN);
    assert.strictEqual(result.errorType, 'transient');
  });

  it('classifies explicit 404', () => {
    const result = classifyPlatformError('HTTP Error 404: Not Found', Platform.YOUTUBE);
    assert.strictEqual(result.errorType, 'not_found');
    assert.strictEqual(result.credentialAction, CredentialAction.KEEP);
    assert.strictEqual(result.retryable, false);
  });

  it('classifies private content', () => {
    const result = classifyPlatformError('This account is private', Platform.INSTAGRAM);
    assert.strictEqual(result.errorType, 'private');
    assert.strictEqual(result.credentialAction, CredentialAction.KEEP);
    assert.strictEqual(result.retryable, false);
  });

  it('classifies geo block', () => {
    const result = classifyPlatformError('video is not available in your country', Platform.YOUTUBE);
    assert.strictEqual(result.errorType, 'geo_blocked');
    assert.strictEqual(result.credentialAction, CredentialAction.KEEP);
    assert.strictEqual(result.retryable, false);
  });

  it('classifies age restriction', () => {
    const result = classifyPlatformError('Sign in to confirm your age', Platform.YOUTUBE);
    assert.strictEqual(result.errorType, 'age_restricted');
    assert.strictEqual(result.credentialAction, CredentialAction.KEEP);
    assert.strictEqual(result.retryable, false);
  });

  it('classifies invalid auth (session expired)', () => {
    const result = classifyPlatformError('session expired', Platform.INSTAGRAM);
    assert.strictEqual(result.errorType, 'auth_invalid');
    assert.strictEqual(result.credentialAction, CredentialAction.DISABLE);
    assert.strictEqual(result.retryable, true);
  });

  console.log('\n--- NEGATIVE NETWORK TESTS (MUST NOT BLOCK/DISABLE/COOLDOWN) ---');
  const infrastructureStrings = [
    'ECONNRESET',
    'ETIMEDOUT',
    'HTTP 500',
    'HTTP 503',
    'socket hang up',
    'dns resolution failed',
  ];

  infrastructureStrings.forEach(str => {
    it(`keeps credential for ${str}`, () => {
      const result = classifyPlatformError(`Error: ${str}`, Platform.INSTAGRAM);
      assert.strictEqual(result.errorType, 'infrastructure');
      assert.strictEqual(result.credentialAction, CredentialAction.KEEP);
      assert.strictEqual(result.retryable, true);
    });
  });

  it('falls back to safe unknown for completely random errors', () => {
    const result = classifyPlatformError('unknown random error', Platform.INSTAGRAM);
    assert.strictEqual(result.errorType, 'transient');
    assert.strictEqual(result.credentialAction, CredentialAction.COOLDOWN);
    assert.strictEqual(result.retryable, true);
  });

  console.log('\n--- Cobalt Fallback Classifier ---');
  it('handles Cobalt 429', () => {
    const result = classifyPlatformError('Cobalt error: 429 Too Many Requests', 'cobalt');
    assert.strictEqual(result.errorType, 'rate_limit');
    assert.strictEqual(result.credentialAction, CredentialAction.COOLDOWN);
  });

  it('handles Cobalt 404', () => {
    const result = classifyPlatformError('Cobalt error: HTTP 404', 'cobalt');
    assert.strictEqual(result.errorType, 'not_found');
    assert.strictEqual(result.credentialAction, CredentialAction.KEEP);
  });

  it('handles Cobalt 500', () => {
    const result = classifyPlatformError('Cobalt error: HTTP 500', 'cobalt');
    assert.strictEqual(result.errorType, 'infrastructure');
    assert.strictEqual(result.credentialAction, CredentialAction.KEEP);
  });

  console.log(`\nTests finished: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(console.error);
