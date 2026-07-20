/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Scope to the package's own nodes/ — anchored at <rootDir> so the assembled
  // build context under .axiom/image/nodes/ (a copy) is never double-collected.
  testMatch: ['<rootDir>/nodes/**/*_test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/.axiom/', '/dist/'],
  // .axiom/dev/ holds a copy of package.json, which makes jest-haste-map warn
  // about a duplicate module name on every run. testPathIgnorePatterns excludes
  // it from COLLECTION; haste still scans it unless it is excluded from module
  // resolution too.
  modulePathIgnorePatterns: ['<rootDir>/.axiom/'],
};
