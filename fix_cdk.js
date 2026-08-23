const fs = require('fs');
let content = fs.readFileSync('apps/infrastructure/lib/infrastructure-stack.ts', 'utf-8');

// 1. Add API_URL
content = content.replace(
  "COBALT_URL: 'http://cobalt.media.internal:9000',",
  "COBALT_URL: 'http://cobalt.media.internal:9000',\n      API_URL: 'http://api.media.internal:3000',"
);

// 2. Add portMappings
content = content.replace(
  "logging: ecs.LogDrivers.awsLogs({ streamPrefix: name }),",
  "logging: ecs.LogDrivers.awsLogs({ streamPrefix: name }),\n          portMappings: [{ containerPort: 3000 }],"
);

// 3. Add cloudMapOptions to createTask ONLY
content = content.replace(
  "enableExecuteCommand: opts?.enableExec ?? false,",
  "enableExecuteCommand: opts?.enableExec ?? false,\n        cloudMapOptions: { name: name.toLowerCase() },"
);

// 4. Add Bot and Api services
content = content.replace(
  "createTask('Relay', '@media-downloader/outbox-publisher');",
  "createTask('Relay', '@media-downloader/outbox-publisher');\n    createTask('Bot', '@media-downloader/bot');\n    createTask('Api', '@media-downloader/api');"
);

fs.writeFileSync('apps/infrastructure/lib/infrastructure-stack.ts', content);
