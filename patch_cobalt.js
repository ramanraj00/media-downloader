const fs = require('fs');
const file = 'services/downloader/src/platforms/cobalt.ts';
let code = fs.readFileSync(file, 'utf-8');

const target = `    if (errorCode === 'error.api.fetch.fail') {`;
const replacement = `    if (errorCode === 'error.api.fetch.empty' || errorCode.includes('login_required') || errorCode === 'error.api.auth.required') {
      throw new AuthRequiredError(
        \`Cobalt: Auth required / Empty fetch. Code: \${errorCode}\`,
        contextService || undefined
      );
    }

    if (errorCode === 'error.api.fetch.fail') {`;

code = code.replace(target, replacement);
fs.writeFileSync(file, code);
console.log('Patched cobalt.ts');
