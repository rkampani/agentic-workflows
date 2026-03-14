export interface AuthParams {
  url: string;
  username: string;
  password: string;
  tokenField?: string;
}

export function buildSetupBlock(auth?: AuthParams): string {
  if (!auth) return "";

  const tokenFieldFallback = auth.tokenField
    ? `body[${JSON.stringify(auth.tokenField)}] || body.access_token || body.token || body.id_token`
    : `body.access_token || body.token || body.id_token`;

  return `
export function setup() {
  const authRes = http.post(${JSON.stringify(auth.url)}, JSON.stringify({
    username: ${JSON.stringify(auth.username)},
    password: ${JSON.stringify(auth.password)},
  }), { headers: { 'Content-Type': 'application/json' } });

  if (authRes.status < 200 || authRes.status >= 300) {
    throw new Error('Auth failed with status ' + authRes.status + ': ' + authRes.body);
  }

  const body = JSON.parse(authRes.body);
  const token = ${tokenFieldFallback};
  if (!token) {
    throw new Error('No token found in auth response. Body: ' + authRes.body);
  }
  return { token: 'Bearer ' + token };
}
`;
}

export function buildTokenExpression(
  hasAuth: boolean,
  hasTestData: boolean
): string {
  if (hasAuth) return "(data && data.token) || null";
  if (hasTestData) return "(row && row.token) || null";
  return "null";
}
