// Diagnose CI credentials using read-only calls; never print token or account data.
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) throw new Error('Missing Cloudflare deployment credentials');
if (token !== token.trim() || /^Bearer\s/i.test(token)) throw new Error('Cloudflare Secret must contain only the token value');
const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
async function probe(label, path, body) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    headers, ...(body ? {method: 'POST', body: JSON.stringify(body)} : {}),
  });
  const data = await response.json();
  const ok = response.ok && data.success === true;
  console.log(JSON.stringify({check: label, ok, http_status: response.status,
    error_codes: (data.errors ?? []).map(error => error.code)}));
  return {ok, data};
}
let verified = await probe('User API token verification', '/user/tokens/verify');
if (!verified.ok) verified = await probe('Account API token verification', `/accounts/${account}/tokens/verify`);
if (!verified.ok || verified.data.result?.status !== 'active') throw new Error('Cloudflare token is invalid or inactive');
const checks = await Promise.all([
  probe('Project D1 read access', `/accounts/${account}/d1/database/${config.d1_databases[0].database_id}/query`, {sql: 'SELECT 1 AS ok'}),
  probe('Workers Scripts read access', `/accounts/${account}/workers/scripts`),
]);
if (checks.some(check => !check.ok)) {
  // Token ID identifies the policy in the dashboard; it is not the credential value.
  const tokenId = verified.data.result?.id;
  if (tokenId) {
    console.log(JSON.stringify({verified_token_id: tokenId}));
    const detail = await probe('Read current token policies', `/user/tokens/${tokenId}`);
    if (detail.ok) console.log(JSON.stringify({token_name: detail.data.result?.name,
      policies: (detail.data.result?.policies ?? []).map(policy => ({effect: policy.effect,
        permissions: (policy.permission_groups ?? []).map(group => group.name),
        target_account_included: Object.keys(policy.resources ?? {}).some(resource =>
          resource === 'com.cloudflare.api.account.*' || resource === `com.cloudflare.api.account.${account}`),
      }))}));
  }
  await probe('D1 database list access', `/accounts/${account}/d1/database`);
  throw new Error('Token is active but required target-account resources are not accessible; check token policies and resource scope');
}
