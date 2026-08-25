const fs = require('fs');
const file = 'services/downloader/src/engine.ts';
let code = fs.readFileSync(file, 'utf-8');

// Remove import
code = code.replace("import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';", "");

// Remove instantiation
code = code.replace("const secretsManager = new SecretsManagerClient({ region: 'ap-south-1' });", "");

// Remove usage
const usageTarget = `      // Check if the credential is a Secrets Manager reference
      if (cookieString.startsWith('/media-downloader/') || cookieString.startsWith('arn:aws:secretsmanager')) {
        const command = new GetSecretValueCommand({ SecretId: cookieString });
        const secretResponse = await secretsManager.send(command);
        if (secretResponse.SecretString) {
          cookieString = secretResponse.SecretString;
        }
      }`;

code = code.replace(usageTarget, "");

fs.writeFileSync(file, code);
console.log('Patched secrets');
