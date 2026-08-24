const fs = require('fs');
const file = 'apps/bot/src/handlers/download.ts';
let code = fs.readFileSync(file, 'utf-8');

const target = `        if (error.response?.data?.error) {
          errorMessage = \`❌ \${error.response.data.error}\`;
        } else if (error.message) {
           errorMessage = \`❌ \${error.message}\`;
        }
        
        await ctx.reply(errorMessage);`;

const replacement = `        // User requested NO failure messages of any kind
        // We just log it and stay silent
        // await ctx.reply(errorMessage);`;

code = code.replace(target, replacement);
fs.writeFileSync(file, code);
console.log('Patched bot');
