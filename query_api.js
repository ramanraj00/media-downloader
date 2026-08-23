const { execSync } = require('child_process');
console.log(execSync('curl -s -X GET http://api.media.internal:3000/v1/jobs/1abbc8b5-6e5c-45c6-aaa3-86d557423cca').toString());
process.exit(0);
