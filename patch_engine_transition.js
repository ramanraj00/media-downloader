const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/engine.ts', 'utf-8');

const target = `  // Only DIRECT tier can trigger transitions to EGRESS or AUTHENTICATED.
  // EGRESS and AUTHENTICATED tiers handle their own retry budgets internally.
  if (currentTier !== 'DIRECT') return null;`;

const replacement = `  // Allow fallback from EGRESS to AUTHENTICATED if proxy pool is empty/exhausted
  if (currentTier === 'EGRESS') {
    if ((error instanceof AuthRequiredError || error.name === 'IdentitiesExhaustedError' || error.type === 'IdentitiesExhaustedError' || error instanceof DatacenterBlockedError) && capabilities.supportsAuthenticatedExtraction) {
      return { nextTier: 'AUTHENTICATED', reason: 'egress_failed_fallback_to_auth' };
    }
    return null;
  }

  if (currentTier !== 'DIRECT') return null;`;

code = code.replace(target, replacement);
fs.writeFileSync('services/downloader/src/engine.ts', code);
console.log("Patched engine.ts transitions");
