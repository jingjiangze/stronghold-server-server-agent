// 生成门控验证用的 overlay 副本（data/local-assets.json 指向临时文件，绕过工作树的 D 状态）。
const fs = require('fs');
const path = require('path');
const o = JSON.parse(fs.readFileSync('tools/deploy-ms/overlay.json', 'utf8'));
const e = o.entries.find((x) => x.path === 'data/local-assets.json');
e.from = path.join(process.env.TEMP, 'local-assets.check.json').replace(/\\/g, '/');
fs.writeFileSync(path.join(process.env.TEMP, 'overlay.check.json'), JSON.stringify(o, null, 1));
console.log('check overlay written; scene entry from =', e.from);
