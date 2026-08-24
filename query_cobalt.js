const { execSync } = require('child_process');
console.log(execSync("curl -s -X POST -H 'Content-Type: application/json' -H 'Accept: application/json' -d '{\"url\":\"https://x.com/FrenchHalwai/status/2091487101749792900?s=20\"}' http://cobalt.media.internal:9000/").toString());
process.exit(0);
