const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const files = ['server.js', ...['src','public','scripts','test'].flatMap(dir => readdirSync(dir).filter(f=>f.endsWith('.js')).map(f=>join(dir,f)))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
