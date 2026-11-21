'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');
const dotenv = require('dotenv');

async function getAvailablePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApp(url, process) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error('App server exited before becoming ready.');
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('App server did not become ready.');
}

test('manages router settings, lists profiles, and validates profile selection when creating users', async (t) => {
  const createdUsers = [];
  let expectedRouterCredentials = 'test-app:test-password';
  const mockRouter = http.createServer((req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from(expectedRouterCredentials).toString('base64')}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'invalid user or password' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/rest/ip/hotspot/user/profile') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        { name: 'default' },
        { name: 'PAKET 1' },
        { name: 'PAKET 2' },
      ]));
      return;
    }

    if (req.method === 'PUT' && req.url === '/rest/ip/hotspot/user') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const user = JSON.parse(body);
        if (user.name === 'duplicate') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: 400,
            message: 'Bad Request',
            detail: 'failure: already have user with this name',
          }));
          return;
        }

        createdUsers.push(user);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  mockRouter.listen(0, '127.0.0.1');
  await once(mockRouter, 'listening');
  const routerPort = mockRouter.address().port;
  const appPort = await getAvailablePort();
  const settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mikrotik-settings-test-'));
  const settingsFile = path.join(settingsDirectory, '.env');
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      MIKROTIK_HOST: '127.0.0.1',
      MIKROTIK_PORT: String(routerPort),
      MIKROTIK_PROTOCOL: 'http',
      MIKROTIK_USERNAME: 'test-app',
      MIKROTIK_PASSWORD: 'test-password',
      MIKROTIK_ENV_FILE: settingsFile,
      HOST: '127.0.0.1',
      PORT: String(appPort),
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    app.kill();
    await once(app, 'exit');
    await new Promise((resolve) => mockRouter.close(resolve));
    await fs.rm(settingsDirectory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${appPort}`;
  await waitForApp(baseUrl, app);

  const profilesResponse = await fetch(`${baseUrl}/api/hotspot-profiles`);
  assert.equal(profilesResponse.status, 200);
  assert.deepEqual((await profilesResponse.json()).profiles, ['default', 'PAKET 1', 'PAKET 2']);

  const settingsResponse = await fetch(`${baseUrl}/api/router-settings`);
  assert.equal(settingsResponse.status, 200);
  const initialSettings = (await settingsResponse.json()).settings;
  assert.deepEqual(initialSettings, {
    host: '127.0.0.1',
    protocol: 'http',
    port: routerPort,
    username: 'test-app',
  });
  assert.equal(Object.hasOwn(initialSettings, 'password'), false);

  const crossOriginSettingsResponse = await fetch(`${baseUrl}/api/router-settings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://untrusted.example',
    },
    body: '{}',
  });
  assert.equal(crossOriginSettingsResponse.status, 403);

  const failedSettingsResponse = await fetch(`${baseUrl}/api/router-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      host: '127.0.0.1',
      protocol: 'http',
      port: routerPort,
      username: 'test-app',
      password: 'wrong-password',
    }),
  });
  assert.equal(failedSettingsResponse.status, 502);
  await assert.rejects(fs.access(settingsFile));

  const invalidProfileResponse = await fetch(`${baseUrl}/api/hotspot-users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'guest-invalid',
      password: 'pass123',
      profile: 'missing-profile',
    }),
  });
  assert.equal(invalidProfileResponse.status, 400);
  assert.equal(createdUsers.length, 0);

  const duplicateResponse = await fetch(`${baseUrl}/api/hotspot-users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'duplicate',
      password: 'pass123',
      profile: 'PAKET 1',
    }),
  });
  assert.equal(duplicateResponse.status, 502);
  assert.match((await duplicateResponse.json()).error, /already have user with this name/);
  assert.equal(createdUsers.length, 0);

  const createResponse = await fetch(`${baseUrl}/api/hotspot-users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'guest-01',
      password: 'pass123',
      profile: 'PAKET 2',
    }),
  });
  assert.equal(createResponse.status, 201);
  assert.deepEqual(createdUsers, [{
    name: 'guest-01',
    password: 'pass123',
    profile: 'PAKET 2',
  }]);

  const keepPasswordResponse = await fetch(`${baseUrl}/api/router-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      host: '127.0.0.1',
      protocol: 'http',
      port: routerPort,
      username: 'test-app',
      password: '',
    }),
  });
  assert.equal(keepPasswordResponse.status, 200);
  const settingsWithKeptPassword = dotenv.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(settingsWithKeptPassword.MIKROTIK_PASSWORD, 'test-password');

  const updatedRouterPassword = `new-'quoted-"password"\\`;
  expectedRouterCredentials = `test-app:${updatedRouterPassword}`;
  const saveSettingsResponse = await fetch(`${baseUrl}/api/router-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      host: '127.0.0.1',
      protocol: 'http',
      port: String(routerPort),
      username: 'test-app',
      password: updatedRouterPassword,
    }),
  });
  assert.equal(saveSettingsResponse.status, 200);
  const savedSettings = await saveSettingsResponse.json();
  assert.equal(savedSettings.settings.password, undefined);
  assert.deepEqual(savedSettings.profiles, ['default', 'PAKET 1', 'PAKET 2']);

  const persistedSettings = dotenv.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(persistedSettings.MIKROTIK_HOST, '127.0.0.1');
  assert.equal(
    Buffer.from(persistedSettings.MIKROTIK_PASSWORD_BASE64, 'base64').toString('utf8'),
    updatedRouterPassword,
  );
  assert.equal((await fs.stat(settingsFile)).mode & 0o777, 0o600);

  const updatedProfilesResponse = await fetch(`${baseUrl}/api/hotspot-profiles`);
  assert.equal(updatedProfilesResponse.status, 200);
  assert.deepEqual((await updatedProfilesResponse.json()).profiles, ['default', 'PAKET 1', 'PAKET 2']);
});
