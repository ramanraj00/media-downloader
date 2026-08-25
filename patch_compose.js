const fs = require('fs');
const file = 'docker-compose.yml';
let code = fs.readFileSync(file, 'utf-8');

code = code.replace(/      - cobalt.*/, `      cobalt:
        condition: service_started`);

code = code.replace(/      - api.*/, `      api:
        condition: service_started`);

fs.writeFileSync(file, code);
