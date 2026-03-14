import { buildTokenExpression } from "./auth-block.js";

export function buildTestDataBlock(absPath: string): string {
  return `
// Test data: path params + request bodies — each VU gets a different row (round-robin)
const testData = new SharedArray('test-data', function () {
  return JSON.parse(open('${absPath}'));
});

// Resolve {placeholders} in paths using data row values
function resolvePath(path, row) {
  return path.replace(/\\{(\\w+)\\}/g, (match, key) => row[key] !== undefined ? row[key] : match);
}
`;
}

export function buildVuDataSetup(
  hasTestData: boolean,
  hasAuth: boolean
): string {
  if (!hasTestData && !hasAuth) return "";

  const tokenExpr = buildTokenExpression(hasAuth, hasTestData);

  return `
    ${hasTestData ? `const row = testData[__VU % testData.length];` : ""}
    const _token = ${tokenExpr};
    const headers = {
      'Content-Type': 'application/json',
      ...(_token ? { 'Authorization': _token } : {}),
    };
`;
}
