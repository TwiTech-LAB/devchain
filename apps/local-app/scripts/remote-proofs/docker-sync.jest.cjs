const path = require('node:path');
const project = require('../../package.json').jest.projects.find(
  (p) => p.displayName === 'backend-integration',
);
module.exports = {
  ...project,
  rootDir: path.resolve(__dirname, '../../src'),
  roots: [path.resolve(__dirname, '../../src'), __dirname],
  testMatch: [path.join(__dirname, 'docker-sync.integration.spec.ts')],
};
