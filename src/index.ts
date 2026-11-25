#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import { sanitizeSecretText } from './clients/http.js';
import { createSteamCollectionServer } from './server.js';

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function main(): void {
  let config: ServerConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      writeStderr(`[steam-collection-mcp] Configuration error (${err.code}): ${err.message}`);
    } else {
      const rawKey = process.env['STEAM_API_KEY'];
      const secrets = rawKey ? [rawKey] : [];
      const safe = sanitizeSecretText(err instanceof Error ? err.message : String(err), secrets);
      writeStderr(`[steam-collection-mcp] Startup error: ${safe}`);
    }
    process.exit(1);
  }

  const secrets = [config.steamApiKey];

  const handle = serveStdio(() => createSteamCollectionServer(config), {
    legacy: 'serve',
    onerror: (error) => {
      const safe = sanitizeSecretText(error.message, secrets);
      writeStderr(`[steam-collection-mcp] Transport error: ${safe}`);
    },
  });

  const shutdown = (): void => {
    void handle.close().finally(() => {
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main();
