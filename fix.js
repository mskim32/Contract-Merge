const fs = require('fs');
let data = fs.readFileSync('src/app/page.tsx', 'utf8');
data = data.replace(/\\\`/g, '`').replace(/\\\$/g, '$');
fs.writeFileSync('src/app/page.tsx', data);
