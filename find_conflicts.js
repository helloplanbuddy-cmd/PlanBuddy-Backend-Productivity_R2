const fs = require('fs');
const path = require('path');

function scanDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') {
        scanDir(fullPath);
      }
    } else if (file.endsWith('.js') || file.endsWith('.sql') || file.endsWith('.json') || file.endsWith('.md')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('<<<<<<<') || content.includes('=======') || content.includes('>>>>>>>')) {
        console.log(`CONFLICT MARKER FOUND IN: ${fullPath}`);
      }
    }
  }
}

scanDir('./planbuddy_v9');
