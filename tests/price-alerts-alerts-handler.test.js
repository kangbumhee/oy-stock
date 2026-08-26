const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('all price alert Blob records use the existing private store contract', () => {
  const files = ['_limits.js', '_payment-store.js', '_registry.js', '_store.js'];
  files.forEach((file) => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'api', 'price-alerts', file),
      'utf8'
    );
    assert.doesNotMatch(source, /access:\s*['"]public['"]/);
  });
  const storeSource = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'price-alerts', '_store.js'),
    'utf8'
  );
  assert.match(storeSource, /get\(pathname,\s*\{[\s\S]*?access:\s*['"]private['"]/);
  assert.doesNotMatch(storeSource, /await\s+fetch\s*\(/);
});

test('fresh device alert list opts into transient creation and returns an empty list', async (t) => {
  const authPath = require.resolve('../api/price-alerts/_auth');
  const handlerPath = require.resolve('../api/price-alerts/alerts');
  const previousAuth = require.cache[authPath];
  const previousHandler = require.cache[handlerPath];
  let authOptions = null;

  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      authenticateDevice: async (_req, options) => {
        authOptions = options;
        return {
          created: true,
          record: { alerts: [], push: { active: false, subscription: null } }
        };
      },
      mutateAuthenticatedDevice: async () => {
        throw new Error('mutation_not_expected');
      }
    }
  };
  delete require.cache[handlerPath];
  t.after(() => {
    delete require.cache[handlerPath];
    if (previousHandler) require.cache[handlerPath] = previousHandler;
    if (previousAuth) require.cache[authPath] = previousAuth;
    else delete require.cache[authPath];
  });

  const handler = require(handlerPath);
  const headers = {};
  let body = '';
  const response = {
    statusCode: 0,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    end(value) {
      body = String(value || '');
    }
  };

  await handler({ method: 'GET', headers: {} }, response);

  assert.deepEqual(authOptions, { allowCreate: true });
  assert.equal(response.statusCode, 200);
  assert.equal(headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(body), {
    success: true,
    alerts: [],
    maxAlerts: 10,
    subscribed: false
  });
});
