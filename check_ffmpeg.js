const { execSync } = require('child_process');
console.log(execSync('curl -s -X POST -H "Content-Type: application/json" -H "Accept: application/json" -d \'{"url":"https://www.instagram.com/reel/DcQwQFAIW6D/"}\' http://cobalt.media.internal:9000/').toString());
process.exit(0);
