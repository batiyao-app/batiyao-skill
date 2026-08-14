#!/usr/bin/env node
'use strict';

/**
 * batiyao — command-line access to a Batiyao account.
 *
 * Talks to Batiyao Bridge: RFC 8628 device flow for authentication, then
 * JSON-RPC over the /mcp endpoint for everything else. Deliberately
 * dependency-free (Node 18+ built-ins only) so `npm install -g` pulls no
 * transitive supply chain onto a developer's machine for what is, in the
 * end, a few HTTP calls.
 *
 * Credentials live in ~/.batiyao/credentials.json, mode 0600. The refresh
 * token is long-lived, so this file is as sensitive as an SSH key.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const BASE_URL = process.env.BATIYAO_BASE_URL || 'https://api.batiyao.com';
const CONFIG_DIR = process.env.BATIYAO_CONFIG_DIR || path.join(os.homedir(), '.batiyao');
const CONFIG_FILE = path.join(CONFIG_DIR, 'credentials.json');
const CLIENT_NAME = 'Batiyao CLI';

// The CLI never receives a browser redirect, so this is only present to
// satisfy dynamic client registration. The device flow ignores it.
const PLACEHOLDER_REDIRECT = 'http://localhost/batiyao-cli-unused';

const DEFAULT_SCOPES = [
  'read:feed',
  'read:notifications',
  'read:chat',
  'write:post',
  'write:media',
];

// --- credential storage -----------------------------------------------

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Write with the restrictive mode from the start rather than chmod-ing
  // after: otherwise the token is briefly world-readable on disk.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function clearConfig() {
  try {
    fs.unlinkSync(CONFIG_FILE);
  } catch {
    /* already gone */
  }
}

// --- HTTP helpers -----------------------------------------------------

async function postForm(pathname, params) {
  const res = await fetch(BASE_URL + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postJSON(pathname, payload) {
  const res = await fetch(BASE_URL + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- authentication ---------------------------------------------------

async function ensureClient(config) {
  if (config.client_id) return config.client_id;

  const { status, body } = await postJSON('/oauth/register', {
    client_name: CLIENT_NAME,
    redirect_uris: [PLACEHOLDER_REDIRECT],
  });
  if (status !== 201 || !body.client_id) {
    fail(`Could not register with Batiyao (${status}). ${body.error_description || body.error || ''}`);
  }
  config.client_id = body.client_id;
  writeConfig(config);
  return body.client_id;
}

async function login() {
  const config = readConfig();
  const clientId = await ensureClient(config);

  const start = await postForm('/oauth/device_authorization', {
    client_id: clientId,
    scope: DEFAULT_SCOPES.join(' '),
  });
  if (start.status !== 200) {
    fail(`Could not start sign-in (${start.status}). ${start.body.error_description || start.body.error || ''}`);
  }

  const { device_code, user_code, verification_uri, verification_uri_complete } = start.body;
  let interval = (start.body.interval || 5) * 1000;

  process.stderr.write(
    `\n  Open:  ${verification_uri_complete || verification_uri}\n` +
      `  Code:  ${user_code}\n\n` +
      `  Waiting for you to approve...\n`
  );

  const deadline = Date.now() + (start.body.expires_in || 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await postForm('/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code,
      client_id: clientId,
    });

    if (poll.status === 200) {
      config.access_token = poll.body.access_token;
      config.refresh_token = poll.body.refresh_token;
      config.expires_at = Date.now() + (poll.body.expires_in || 3600) * 1000;
      config.scopes = (poll.body.scope || '').split(' ').filter(Boolean);
      writeConfig(config);
      process.stderr.write('  Connected.\n\n');
      return;
    }

    const err = poll.body.error;
    if (err === 'authorization_pending') continue;
    // The server asks us to back off; RFC 8628 §3.5 says add 5s each time.
    if (err === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (err === 'access_denied') fail('You declined the request. Nothing was connected.');
    if (err === 'expired_token') fail('The code expired. Run `batiyao login` again.');
    fail(`Sign-in failed: ${poll.body.error_description || err || poll.status}`);
  }
  fail('Timed out waiting for approval. Run `batiyao login` again.');
}

async function refreshAccessToken(config) {
  if (!config.refresh_token) return false;
  const { status, body } = await postForm('/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: config.refresh_token,
    client_id: config.client_id,
  });
  if (status !== 200) return false;

  config.access_token = body.access_token;
  config.refresh_token = body.refresh_token;
  config.expires_at = Date.now() + (body.expires_in || 3600) * 1000;
  writeConfig(config);
  return true;
}

// --- MCP calls --------------------------------------------------------

let rpcId = 0;

async function callTool(name, args) {
  const config = readConfig();
  if (!config.access_token) {
    fail('Not connected. Run `batiyao login` first.');
  }

  // Refresh slightly ahead of expiry so a call doesn't fail on a token that
  // dies mid-flight.
  if (config.expires_at && Date.now() > config.expires_at - 60000) {
    await refreshAccessToken(config);
  }

  const send = async (token) =>
    fetch(BASE_URL + '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

  let res = await send(config.access_token);
  if (res.status === 401) {
    const fresh = readConfig();
    if (await refreshAccessToken(fresh)) {
      res = await send(fresh.access_token);
    }
  }

  const body = await res.json().catch(() => ({}));
  if (body.error) {
    fail(`Batiyao returned an error: ${body.error.message || JSON.stringify(body.error)}`);
  }

  const content = body.result && body.result.content && body.result.content[0];
  const text = content ? content.text : '';
  if (body.result && body.result.isError) {
    fail(text || 'The request was denied.');
  }
  return text;
}

// --- argument parsing -------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      // Repeatable flags (--media) collect rather than overwrite.
      if (flags[key] === undefined) flags[key] = value;
      else if (Array.isArray(flags[key])) flags[key].push(value);
      else flags[key] = [flags[key], value];
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function fail(message) {
  process.stderr.write(`\nbatiyao: ${message}\n\n`);
  process.exit(1);
}

// --- commands ---------------------------------------------------------

async function main() {
  const [, , command, ...rest] = process.argv;
  const { flags, positional } = parseFlags(rest);

  switch (command) {
    case 'login':
      return login();

    case 'logout': {
      clearConfig();
      process.stderr.write(
        '\n  Local credentials removed.\n' +
          '  To revoke access on the server too, use Settings -> Connected apps on Batiyao.\n\n'
      );
      return;
    }

    case 'status': {
      const config = readConfig();
      if (!config.access_token) {
        process.stdout.write(JSON.stringify({ connected: false }, null, 2) + '\n');
        process.exit(2);
      }
      process.stdout.write(
        JSON.stringify({ connected: true, base_url: BASE_URL, scopes: config.scopes || [] }, null, 2) + '\n'
      );
      return;
    }

    case 'feed':
      return output(await callTool('get_updates', { limit: Number(flags.limit) || 20 }));

    case 'post-get': {
      const id = positional[0];
      if (!id) fail('Usage: batiyao post-get <post_id>');
      return output(await callTool('get_post', { post_id: id }));
    }

    case 'notifications':
      return output(await callTool('get_notifications', {}));

    case 'profile':
      return output(await callTool('get_profile', {}));

    case 'chats': {
      const id = positional[0];
      return output(await callTool('get_chat', id ? { conversation_id: id } : {}));
    }

    case 'upload': {
      const file = positional[0];
      if (!file) fail('Usage: batiyao upload <path>');
      if (!fs.existsSync(file)) fail(`No such file: ${file}`);
      const data = fs.readFileSync(file);
      return output(
        await callTool('upload_media', {
          filename: path.basename(file),
          content_type: guessContentType(file),
          data_base64: data.toString('base64'),
        })
      );
    }

    case 'post': {
      const content = positional[0];
      if (!content) fail('Usage: batiyao post "<text>" --rating <sfw|suggestive|nsfw> --reasoning "<why>"');

      const rating = flags.rating;
      if (!['sfw', 'suggestive', 'nsfw'].includes(rating)) {
        fail('--rating must be one of: sfw, suggestive, nsfw');
      }
      if (!flags.reasoning || flags.reasoning === 'true') {
        fail('--reasoning is required: state briefly why you chose that rating.');
      }

      // A human must see the exact text before it goes out. --yes exists for
      // non-interactive use, but the default is to stop and ask, because the
      // caller here is usually an agent and this spends the user's tokens
      // and publishes under their name.
      if (flags.yes !== 'true' && process.stdin.isTTY) {
        const ok = await confirm(content, rating);
        if (!ok) fail('Cancelled. Nothing was posted.');
      }

      return output(
        await callTool('create_post', {
          content,
          media_ids: asArray(flags.media),
          content_rating: rating,
          rating_reasoning: flags.reasoning,
        })
      );
    }

    default:
      process.stderr.write(usage());
      process.exit(command ? 1 : 0);
  }
}

function output(text) {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function confirm(content, rating) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    process.stderr.write(`\n  About to post to Batiyao as you (${rating}):\n\n`);
    process.stderr.write(
      content
        .split('\n')
        .map((line) => '    ' + line)
        .join('\n') + '\n\n'
    );
    rl.question('  Post this? [y/N] ', (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function guessContentType(file) {
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  };
  return types[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function usage() {
  return `
  batiyao — command-line access to your Batiyao account

    batiyao login                     connect this machine to your account
    batiyao logout                    remove local credentials
    batiyao status                    show whether this machine is connected

    batiyao feed [--limit N]          your home feed
    batiyao post-get <post_id>        one post
    batiyao notifications             recent activity
    batiyao profile                   your profile and stats
    batiyao chats [conversation_id]   conversations, or one conversation

    batiyao upload <path>             upload media, prints a media_id
    batiyao post "<text>" --rating <sfw|suggestive|nsfw> --reasoning "<why>"
                          [--media <media_id>]... [--yes]

  Set BATIYAO_BASE_URL to point at a different Batiyao instance.

`;
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
