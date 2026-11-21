'use strict';

const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const dotenv = require('dotenv');
const envFilePath = process.env.MIKROTIK_ENV_FILE || path.join(__dirname, '.env');
dotenv.config({ path: envFilePath });

const express = require('express');

function environmentValue(name) {
  const encoded = process.env[`${name}_BASE64`];
  if (encoded) {
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded) {
      throw new Error(`${name}_BASE64 must be valid base64.`);
    }
    return decoded.toString('utf8');
  }
  return process.env[name];
}

function requiredEnv(name, trim = true) {
  const rawValue = environmentValue(name);
  const value = trim ? rawValue?.trim() : rawValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveNumber(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}

function positivePort(name, fallback) {
  return positiveNumber(process.env[name] || fallback, name);
}

function makeRouterConfig(values) {
  const host = typeof values.host === 'string' ? values.host.trim() : '';
  const protocol = values.protocol;
  const port = positiveNumber(values.port, 'MikroTik port');
  const username = typeof values.username === 'string' ? values.username.trim() : '';
  const password = typeof values.password === 'string' ? values.password : '';

  if (
    !host
    || host.length > 253
    || /[/\\?#@\s\u0000-\u001f\u007f]/.test(host)
    || host.includes('://')
  ) {
    throw new Error('Alamat MikroTik harus berupa IP atau hostname tanpa scheme atau path.');
  }
  if (!['http', 'https'].includes(protocol)) {
    throw new Error('Protocol harus berupa HTTP atau HTTPS.');
  }
  if (!username || username.length > 128 || username.includes(':') || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error('Username API MikroTik tidak valid.');
  }
  if (!password || password.length > 256 || /[\u0000-\u001f\u007f]/.test(password)) {
    throw new Error('Password API MikroTik tidak valid.');
  }

  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  let restUrl;
  try {
    restUrl = new URL(`${protocol}://${urlHost}:${port}/rest/`);
  } catch {
    throw new Error('Alamat MikroTik tidak valid. Masukkan IP atau hostname yang benar.');
  }
  return { host, protocol, port, username, password, restUrl };
}

let routerConfig = makeRouterConfig({
  host: requiredEnv('MIKROTIK_HOST'),
  protocol: environmentValue('MIKROTIK_PROTOCOL') || 'https',
  port: environmentValue('MIKROTIK_PORT') || (environmentValue('MIKROTIK_PROTOCOL') === 'http' ? 80 : 443),
  username: requiredEnv('MIKROTIK_USERNAME'),
  password: requiredEnv('MIKROTIK_PASSWORD', false),
});
const app = express();
const appHost = process.env.HOST || '127.0.0.1';
const appPort = positivePort('PORT', 3000);

class RouterApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function routerRequest(resource, options = {}, config = routerConfig) {
  let response;
  try {
    const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    response = await fetch(new URL(resource, config.restUrl), {
      method: options.method || 'GET',
      headers: {
        authorization,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    console.error(`RouterOS REST request failed: ${error.message}`);
    throw new RouterApiError(
      timedOut ? 504 : 502,
      timedOut
        ? 'Koneksi ke MikroTik timeout.'
        : 'Tidak dapat terhubung ke MikroTik. Periksa alamat, port, dan sertifikat HTTPS.',
    );
  }

  if (!response.ok) {
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    const rawDetail = payload && typeof payload.detail === 'string'
      ? payload.detail
      : payload && typeof payload.message === 'string'
        ? payload.message
        : '';
    const detail = rawDetail
      .replaceAll(config.password, '[redacted]')
      .replaceAll(config.username, '[redacted]')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, 300);
    console.error(`RouterOS REST returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`);
    throw new RouterApiError(
      502,
      detail
        ? `MikroTik menolak permintaan: ${detail}`
        : 'MikroTik menolak permintaan. Periksa credential, profile, dan izin akun API.',
    );
  }

  return response;
}

async function readHotspotProfiles(config = routerConfig) {
  const response = await routerRequest('ip/hotspot/user/profile', {}, config);
  let rows;
  try {
    rows = await response.json();
  } catch {
    throw new RouterApiError(502, 'MikroTik mengirim daftar profile dengan format tidak valid.');
  }

  if (!Array.isArray(rows)) {
    throw new RouterApiError(502, 'MikroTik mengirim daftar profile dengan format tidak valid.');
  }

  return [...new Set(rows
    .map((row) => row && typeof row.name === 'string' ? row.name : '')
    .filter((name) => name.trim() !== ''))];
}

function getPublicRouterSettings(config = routerConfig) {
  return {
    host: config.host,
    protocol: config.protocol,
    port: config.port,
    username: config.username,
  };
}

function isLocalAdminRequest(req, res, next) {
  const address = req.socket.remoteAddress || '';
  const normalizedAddress = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (normalizedAddress !== '::1' && !normalizedAddress.startsWith('127.')) {
    return res.status(403).json({ error: 'Pengaturan koneksi hanya dapat diubah dari komputer server.' });
  }

  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ error: 'Permintaan pengaturan koneksi harus berasal dari aplikasi ini.' });
      }
    } catch {
      return res.status(403).json({ error: 'Origin permintaan tidak valid.' });
    }
  }

  return next();
}

function serializeEnvValue(value) {
  if (value.includes('"') || value.includes('\\')) {
    return {
      value: '""',
      base64: JSON.stringify(Buffer.from(value, 'utf8').toString('base64')),
    };
  }

  return { value: JSON.stringify(value), base64: '""' };
}

function updateEnvContent(contents, config) {
  const values = new Map();
  for (const [name, value] of Object.entries({
    MIKROTIK_HOST: config.host,
    MIKROTIK_PROTOCOL: config.protocol,
    MIKROTIK_PORT: String(config.port),
    MIKROTIK_USERNAME: config.username,
    MIKROTIK_PASSWORD: config.password,
  })) {
    const serialized = serializeEnvValue(value);
    values.set(name, serialized.value);
    values.set(`${name}_BASE64`, serialized.base64);
  }

  const seen = new Set();
  const lines = (contents ? contents.split(/\r?\n/) : []).map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !values.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${values.get(match[1])}`;
  });

  for (const [name, value] of values) {
    if (!seen.has(name)) lines.push(`${name}=${value}`);
  }

  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

async function persistRouterConfig(config) {
  let contents = '';
  try {
    contents = await fs.readFile(envFilePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${envFilePath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryFileCreated = false;
  try {
    await fs.writeFile(temporaryPath, updateEnvContent(contents, config), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    temporaryFileCreated = true;
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, envFilePath);
    temporaryFileCreated = false;
  } catch (error) {
    if (temporaryFileCreated) await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function updateProcessEnvironment(config) {
  for (const [name, value] of Object.entries({
    MIKROTIK_HOST: config.host,
    MIKROTIK_PROTOCOL: config.protocol,
    MIKROTIK_PORT: String(config.port),
    MIKROTIK_USERNAME: config.username,
    MIKROTIK_PASSWORD: config.password,
  })) {
    process.env[name] = value;
    delete process.env[`${name}_BASE64`];
  }
}

function sendRouterError(res, error) {
  if (error instanceof RouterApiError) {
    return res.status(error.statusCode).json({ error: error.message });
  }

  console.error(`RouterOS response processing failed: ${error.message}`);
  return res.status(502).json({ error: 'Respons MikroTik tidak dapat diproses.' });
}

app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/router-settings', isLocalAdminRequest, (req, res) => {
  return res.json({ settings: getPublicRouterSettings() });
});

app.post('/api/router-settings', isLocalAdminRequest, async (req, res) => {
  const { host, protocol, port, username, password } = req.body ?? {};
  if (
    typeof host !== 'string'
    || typeof protocol !== 'string'
    || (typeof port !== 'string' && typeof port !== 'number')
    || typeof username !== 'string'
    || (password !== undefined && typeof password !== 'string')
  ) {
    return res.status(400).json({ error: 'Lengkapi alamat, protocol, port, dan username API MikroTik.' });
  }

  let candidateConfig;
  try {
    candidateConfig = makeRouterConfig({
      host,
      protocol,
      port,
      username,
      password: password ? password : routerConfig.password,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  let profiles;
  try {
    profiles = await readHotspotProfiles(candidateConfig);
  } catch (error) {
    return sendRouterError(res, error);
  }

  try {
    await persistRouterConfig(candidateConfig);
  } catch (error) {
    console.error(`Unable to save MikroTik settings: ${error.message}`);
    return res.status(500).json({ error: 'Koneksi berhasil, tetapi pengaturan tidak dapat disimpan ke .env.' });
  }

  routerConfig = candidateConfig;
  updateProcessEnvironment(candidateConfig);
  return res.json({
    message: 'Koneksi MikroTik berhasil diuji dan pengaturan telah disimpan.',
    profiles,
    settings: getPublicRouterSettings(candidateConfig),
  });
});

app.get('/api/hotspot-profiles', async (req, res) => {
  try {
    return res.json({ profiles: await readHotspotProfiles() });
  } catch (error) {
    return sendRouterError(res, error);
  }
});

app.post('/api/hotspot-users', async (req, res) => {
  const { username, password, profile } = req.body ?? {};
  if (
    typeof username !== 'string'
    || typeof password !== 'string'
    || typeof profile !== 'string'
    || username.trim().length < 1
    || username.trim().length > 64
    || password.length < 1
    || password.length > 128
    || /[\u0000-\u001f\u007f]/.test(username)
    || /[\u0000-\u001f\u007f]/.test(password)
    || profile.trim().length < 1
    || profile.length > 255
    || /[\u0000-\u001f\u007f]/.test(profile)
  ) {
    return res.status(400).json({ error: 'Username, password, atau profile tidak valid.' });
  }

  try {
    const profiles = await readHotspotProfiles();
    if (!profiles.includes(profile)) {
      return res.status(400).json({ error: 'Profile tidak tersedia di MikroTik. Muat ulang pilihan profile.' });
    }

    await routerRequest('ip/hotspot/user', {
      method: 'PUT',
      body: {
        name: username.trim(),
        password,
        profile,
      },
    });
    return res.status(201).json({ message: 'User Hotspot berhasil dibuat.' });
  } catch (error) {
    return sendRouterError(res, error);
  }
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Format JSON tidak valid.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Permintaan terlalu besar.' });
  }
  console.error(`Request failed: ${error.message}`);
  return res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

app.listen(appPort, appHost, () => {
  console.log(`Web app running at http://${appHost}:${appPort}`);
});
