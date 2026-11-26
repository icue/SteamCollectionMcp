import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import {
  GameStatusOutputSchema,
  GetGamesStatusOutputSchema,
  ListOwnedGamesOutputSchema,
  ListWishlistGamesOutputSchema,
  ResolveGameOutputSchema,
} from '../../src/schemas.js';
import { TEST_STEAM_API_KEY, TEST_STEAM_ID } from '../fixtures/steam-responses.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const PRELOAD_SCRIPT = pathToFileURL(path.join(__dirname, 'stdio-fetch-preload.mjs')).href;

function checkToolPayload(res: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}): unknown {
  expect(res.isError).not.toBe(true);
  expect(res.content).toHaveLength(1);
  const text = res.content[0]?.text;
  expect(typeof text).toBe('string');
  const parsed = JSON.parse(text!);
  expect(res.structuredContent).toEqual(parsed);
  return parsed;
}

describe('Real subprocess stdio E2E against built dist/index.js', () => {
  it('ships dist/index.js with #!/usr/bin/env node shebang', async () => {
    const content = await readFile(DIST_ENTRY, 'utf8');
    expect(content.startsWith('#!/usr/bin/env node\n') || content.startsWith('#!/usr/bin/env node\r\n')).toBe(
      true,
    );
  });

  it('fails fast with non-zero exit, empty stdout, and sanitized stderr on missing/invalid config', async () => {
    const secret = 'NEVER_LEAK_THIS_KEY_ABC123';
    try {
      await execFileAsync(process.execPath, [DIST_ENTRY], {
        env: {
          PATH: process.env['PATH'] ?? '',
          STEAM_API_KEY: `${secret} bad`,
          STEAM_ID: TEST_STEAM_ID,
        },
        timeout: 10_000,
      });
      expect.unreachable('expected non-zero exit');
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      expect(e.code).toBe(1);
      expect(e.stdout).toBe('');
      expect(e.stderr).toContain('Configuration error');
      expect(e.stderr).not.toContain(secret);
    }

    // Prototype property names and malformed/mismatched BCP 47 tags in STEAM_LANGUAGE must fail startup validation
    for (const badLang of ['constructor', 'en-u', 'en-US-GB', 'en-cmn', 'zh-arb']) {
      try {
        await execFileAsync(process.execPath, [DIST_ENTRY], {
          env: {
            PATH: process.env['PATH'] ?? '',
            STEAM_API_KEY: secret,
            STEAM_ID: TEST_STEAM_ID,
            STEAM_LANGUAGE: badLang,
          },
          timeout: 10_000,
        });
        expect.unreachable(`expected non-zero exit for STEAM_LANGUAGE=${badLang}`);
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        expect(e.code).toBe(1);
        expect(e.stdout).toBe('');
        expect(e.stderr).toContain('invalid_steam_language');
        expect(e.stderr).not.toContain(secret);
        expect(e.stderr).not.toContain(badLang);
      }
    }
  });

  it('initializes, lists exactly 5 read-only tools, and invokes all 5 tools over real stdio JSON-RPC', async () => {
    const stderrChunks: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', PRELOAD_SCRIPT, DIST_ENTRY],
      env: {
        PATH: process.env['PATH'] ?? '',
        STEAM_API_KEY: TEST_STEAM_API_KEY,
        STEAM_ID: TEST_STEAM_ID,
        STEAM_COUNTRY: 'US',
        STEAM_LANGUAGE: 'english',
        E2E_MOCK_MODE: 'ok',
      },
      stderr: 'pipe',
    });

    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf8'));
    });

    const client = new Client({ name: 'stdio-e2e-client', version: '0.1.0' });
    await client.connect(transport);

    try {
      const { version } = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        version: string;
      };
      expect(client.getServerVersion()).toMatchObject({ name: 'steam-collection', version });

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'get_game_status',
        'get_games_status',
        'list_owned_games',
        'list_wishlist_games',
        'resolve_game',
      ]);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.outputSchema).toBeDefined();
      }
      const toolsByName = new Map(tools.map((t) => [t.name, t]));
      const ownedSortProp = (
        toolsByName.get('list_owned_games')?.inputSchema.properties as Record<
          string,
          Record<string, unknown>
        >
      )?.['sort_by'];
      expect(ownedSortProp).toMatchObject({
        type: 'string',
        enum: ['appid', 'last_played', 'playtime_asc', 'playtime_desc'],
        default: 'appid',
      });
      expect(String(ownedSortProp?.['description'] ?? '')).toMatch(/minutes/i);
      expect(String(ownedSortProp?.['description'] ?? '')).toMatch(/missing\/null/i);
      expect(String(ownedSortProp?.['description'] ?? '')).toMatch(/AppID ascending/i);
      expect(
        (toolsByName.get('list_wishlist_games')?.inputSchema.properties as Record<string, unknown>)[
          'sort_by'
        ],
      ).toBeUndefined();

      // 1. list_owned_games
      const owned = ListOwnedGamesOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'list_owned_games',
            arguments: { offset: 0, limit: 10, language: 'zh-CN', include_metadata: true },
          })) as never,
        ),
      );
      expect(owned.list).toBe('owned');
      expect(owned.total).toBe(2);
      expect(owned.games[0]).toMatchObject({ appid: 1091500, name: '赛博朋克 2077' });

      // 2. list_wishlist_games
      const wishlist = ListWishlistGamesOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'list_wishlist_games',
            arguments: { offset: 0, limit: 10, include_metadata: true },
          })) as never,
        ),
      );
      expect(wishlist.list).toBe('wishlist');
      expect(wishlist.total).toBe(2);
      expect(wishlist.games.map((g) => g.appid)).toEqual([1086940, 1245620]);

      // 3. resolve_game
      const resolved = ResolveGameOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'resolve_game',
            arguments: { query: '赛博朋克2077', language: 'zh-CN', alternative_names: ['Cyberpunk 2077'] },
          })) as never,
        ),
      );
      expect(resolved.resolution).toBe('resolved');
      expect(resolved.appid).toBe(1091500);

      // 4. get_game_status
      const single = GameStatusOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'get_game_status',
            arguments: { query: 'Hades' },
          })) as never,
        ),
      );
      expect(single.appid).toBe(1145360);
      expect(single.owned).toBe(true);
      expect(single.wishlisted).toBe(false);

      // 5. get_games_status
      const batch = GetGamesStatusOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'get_games_status',
            arguments: {
              queries: [
                { query: 'Hades' },
                { query: '1086940' },
                { query: 'https://store.steampowered.com/app/1091500/' },
              ],
            },
          })) as never,
        ),
      );
      expect(batch.total).toBe(3);
      expect(batch.results.map((r) => ({ appid: r.appid, owned: r.owned, wishlisted: r.wishlisted }))).toEqual([
        { appid: 1145360, owned: true, wishlisted: false },
        { appid: 1086940, owned: false, wishlisted: true },
        { appid: 1091500, owned: true, wishlisted: false },
      ]);

      expect(stderrChunks.join('')).not.toContain(TEST_STEAM_API_KEY);
    } finally {
      await client.close();
    }
  });

  it('returns isError=true without leaking secrets when list source fails over stdio', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', PRELOAD_SCRIPT, DIST_ENTRY],
      env: {
        PATH: process.env['PATH'] ?? '',
        STEAM_API_KEY: TEST_STEAM_API_KEY,
        STEAM_ID: TEST_STEAM_ID,
        E2E_MOCK_MODE: 'owned_fail',
      },
      stderr: 'pipe',
    });

    const client = new Client({ name: 'stdio-e2e-err-client', version: '0.1.0' });
    await client.connect(transport);
    try {
      const res = await client.callTool({
        name: 'list_owned_games',
        arguments: {},
      });
      expect(res.isError).toBe(true);
      const errText = (res.content[0] as { text?: string })?.text ?? '';
      expect(errText).not.toContain(TEST_STEAM_API_KEY);
      expect(JSON.parse(errText)).toMatchObject({
        list: 'owned',
        data_status: 'unavailable',
        error_code: 'invalid_api_key',
      });
    } finally {
      await client.close();
    }
  });

  it('returns wire isError=true with schema-valid structuredContent when StoreSearch returns 403 over real stdio', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', PRELOAD_SCRIPT, DIST_ENTRY],
      env: {
        PATH: process.env['PATH'] ?? '',
        STEAM_API_KEY: TEST_STEAM_API_KEY,
        STEAM_ID: TEST_STEAM_ID,
        E2E_MOCK_MODE: 'search_403',
      },
      stderr: 'pipe',
    });

    const client = new Client({ name: 'stdio-e2e-403-client', version: '0.1.0' });
    await client.connect(transport);
    try {
      const resolveRes = await client.callTool({
        name: 'resolve_game',
        arguments: { query: 'Hades' },
      });
      expect(resolveRes.isError).toBe(true);
      const resolveJson = ResolveGameOutputSchema.parse(
        JSON.parse((resolveRes.content[0] as { text: string }).text),
      );
      expect(resolveRes.structuredContent).toEqual(resolveJson);
      expect(resolveJson.resolution).toBe('error');
      expect(resolveJson.error_code).toBe('access_denied');

      const statusRes = await client.callTool({
        name: 'get_game_status',
        arguments: { query: 'Hades' },
      });
      expect(statusRes.isError).toBe(true);
      const statusJson = GameStatusOutputSchema.parse(
        JSON.parse((statusRes.content[0] as { text: string }).text),
      );
      expect(statusRes.structuredContent).toEqual(statusJson);
      expect(statusJson.resolution).toBe('error');
      expect(statusJson.error_code).toBe('access_denied');

      const batchRes = await client.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: 'Hades' }, { query: 'Cyberpunk 2077' }] },
      });
      expect(batchRes.isError).toBe(true);
      const batchJson = GetGamesStatusOutputSchema.parse(
        JSON.parse((batchRes.content[0] as { text: string }).text),
      );
      expect(batchRes.structuredContent).toEqual(batchJson);
      expect(batchJson.results.map((r) => [r.resolution, r.error_code])).toEqual([
        ['error', 'access_denied'],
        ['error', 'access_denied'],
      ]);
    } finally {
      await client.close();
    }
  });

  it('preserves wire isError semantics over real stdio for ambiguous-with-source-failures, mixed batches, and resolved-without-collection-booleans', async () => {
    // 1. Ambiguous homonyms + owned 401 + wishlist 403
    const transport1 = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', PRELOAD_SCRIPT, DIST_ENTRY],
      env: {
        PATH: process.env['PATH'] ?? '',
        STEAM_API_KEY: TEST_STEAM_API_KEY,
        STEAM_ID: TEST_STEAM_ID,
        E2E_MOCK_MODE: 'ambiguous_sources_fail',
      },
      stderr: 'pipe',
    });
    const client1 = new Client({ name: 'stdio-e2e-ambig-client', version: '0.1.0' });
    await client1.connect(transport1);
    try {
      // Single ambiguous -> isError NOT true
      const singleAmb = await client1.callTool({
        name: 'get_game_status',
        arguments: { query: 'Signal' },
      });
      const psa = GameStatusOutputSchema.parse(checkToolPayload(singleAmb as never));
      expect(psa.resolution).toBe('ambiguous');
      expect(psa.owned_error_code).toBe('invalid_api_key');
      expect(psa.wishlist_error_code).toBe('access_denied');

      // Pure ambiguous batch -> isError NOT true
      const batchAmb = await client1.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: 'Signal' }] },
      });
      const pba = GetGamesStatusOutputSchema.parse(checkToolPayload(batchAmb as never));
      expect(pba.results[0]?.resolution).toBe('ambiguous');

      // Mixed batch (direct AppID + ambiguous) -> isError NOT true
      const mixedAmb = await client1.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: '10' }, { query: 'Signal' }] },
      });
      const pma = GetGamesStatusOutputSchema.parse(checkToolPayload(mixedAmb as never));
      expect(pma.results.map((r) => r.resolution)).toEqual(['resolved', 'ambiguous']);

      // Resolved direct AppID alone with both sources failing -> isError === true with diagnostics
      const directFail = await client1.callTool({
        name: 'get_game_status',
        arguments: { query: '10' },
      });
      expect(directFail.isError).toBe(true);
      const pdf = GameStatusOutputSchema.parse(
        JSON.parse((directFail.content[0] as { text: string }).text),
      );
      expect(directFail.structuredContent).toEqual(pdf);
      expect(pdf.resolution).toBe('resolved');
      expect(pdf.appid).toBe(10);
      expect(pdf.owned).toBeNull();
      expect(pdf.wishlisted).toBeNull();
    } finally {
      await client1.close();
    }

    // 2. Mixed batch with one search error + one reliable not_found -> isError NOT true
    const transport2 = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', PRELOAD_SCRIPT, DIST_ENTRY],
      env: {
        PATH: process.env['PATH'] ?? '',
        STEAM_API_KEY: TEST_STEAM_API_KEY,
        STEAM_ID: TEST_STEAM_ID,
        E2E_MOCK_MODE: 'mixed_partial_search',
      },
      stderr: 'pipe',
    });
    const client2 = new Client({ name: 'stdio-e2e-mixed-client', version: '0.1.0' });
    await client2.connect(transport2);
    try {
      const mixedRes = await client2.callTool({
        name: 'get_games_status',
        arguments: { queries: [{ query: 'Unavailable' }, { query: 'Certainly Missing' }] },
      });
      const pm = GetGamesStatusOutputSchema.parse(checkToolPayload(mixedRes as never));
      expect(pm.results.map((r) => r.resolution)).toEqual(['error', 'not_found']);
    } finally {
      await client2.close();
    }
  });

  it('preserves raw query strings (ASCII and Unicode whitespace) across all three query tools, exposes valid inputSchema without raw maxLength, and enforces trimmed validation over real stdio', async () => {
    const stderrChunks: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', PRELOAD_SCRIPT, DIST_ENTRY],
      env: {
        PATH: process.env['PATH'] ?? '',
        STEAM_API_KEY: TEST_STEAM_API_KEY,
        STEAM_ID: TEST_STEAM_ID,
        STEAM_COUNTRY: 'US',
        STEAM_LANGUAGE: 'english',
        E2E_MOCK_MODE: 'ok',
      },
      stderr: 'pipe',
    });

    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf8'));
    });

    const client = new Client({ name: 'stdio-e2e-query-preservation-client', version: '0.1.0' });
    await client.connect(transport);

    try {
      // 1. Exported JSON Schema must accept whitespace-padded strings with trimmed length <= 300
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const toolName of ['resolve_game', 'get_game_status'] as const) {
        const queryProp = (
          byName.get(toolName)?.inputSchema.properties as Record<string, Record<string, unknown>>
        )?.['query'];
        expect(queryProp?.['type']).toBe('string');
        expect(queryProp?.['minLength']).toBe(1);
        expect(queryProp?.['maxLength']).toBeUndefined();
      }
      const batchItemQueryProp = (
        (
          (
            byName.get('get_games_status')?.inputSchema.properties as Record<
              string,
              Record<string, unknown>
            >
          )?.['queries']?.['items'] as Record<string, unknown>
        )?.['properties'] as Record<string, Record<string, unknown>>
      )?.['query'];
      expect(batchItemQueryProp?.['type']).toBe('string');
      expect(batchItemQueryProp?.['minLength']).toBe(1);
      expect(batchItemQueryProp?.['maxLength']).toBeUndefined();

      // 2. resolve_game preserves ASCII spaces, Unicode spaces/tabs, padded trimmed-300 strings, and rejected URLs
      const asciiPaddedResolve = ResolveGameOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'resolve_game',
            arguments: { query: '  Hades  ' },
          })) as never,
        ),
      );
      expect(asciiPaddedResolve.query).toBe('  Hades  ');
      expect(asciiPaddedResolve.resolution).toBe('resolved');
      expect(asciiPaddedResolve.appid).toBe(1145360);

      const unicodePaddedQuery = '\u3000\t赛博朋克2077\u00a0 ';
      const unicodePaddedResolve = ResolveGameOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'resolve_game',
            arguments: { query: unicodePaddedQuery, language: 'zh-CN' },
          })) as never,
        ),
      );
      expect(unicodePaddedResolve.query).toBe(unicodePaddedQuery);
      expect(unicodePaddedResolve.resolution).toBe('resolved');
      expect(unicodePaddedResolve.appid).toBe(1091500);

      const padded300 = `   ${'a'.repeat(300)}   `;
      const padded300Res = ResolveGameOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'resolve_game',
            arguments: { query: padded300 },
          })) as never,
        ),
      );
      expect(padded300Res.query).toBe(padded300);
      expect(padded300Res.resolution).toBe('not_found');

      const paddedRejectedUrl = '  https://store.steampowered.com/bundle/232/  ';
      const rejectedUrlRes = await client.callTool({
        name: 'resolve_game',
        arguments: { query: paddedRejectedUrl },
      });
      expect(rejectedUrlRes.isError).toBe(true);
      const rejectedUrlJson = ResolveGameOutputSchema.parse(
        JSON.parse((rejectedUrlRes.content[0] as { text: string }).text),
      );
      expect(rejectedUrlRes.structuredContent).toEqual(rejectedUrlJson);
      expect(rejectedUrlJson.query).toBe(paddedRejectedUrl);
      expect(rejectedUrlJson.resolution).toBe('error');
      expect(rejectedUrlJson.error_code).toBe('invalid_query');

      // 3. get_game_status preserves raw query across padded AppID, Unicode-padded URL, and Unicode-padded name
      const singleAppId = GameStatusOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'get_game_status',
            arguments: { query: '  1145360  ' },
          })) as never,
        ),
      );
      expect(singleAppId.query).toBe('  1145360  ');
      expect(singleAppId.appid).toBe(1145360);
      expect(singleAppId.owned).toBe(true);
      expect(singleAppId.wishlisted).toBe(false);

      const paddedUrl = '\t\u3000https://store.steampowered.com/app/1086940/\u00a0';
      const singleUrl = GameStatusOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'get_game_status',
            arguments: { query: paddedUrl },
          })) as never,
        ),
      );
      expect(singleUrl.query).toBe(paddedUrl);
      expect(singleUrl.appid).toBe(1086940);
      expect(singleUrl.owned).toBe(false);
      expect(singleUrl.wishlisted).toBe(true);

      const singleUnicodeName = GameStatusOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'get_game_status',
            arguments: { query: '\u3000\tHades\u00a0' },
          })) as never,
        ),
      );
      expect(singleUnicodeName.query).toBe('\u3000\tHades\u00a0');
      expect(singleUnicodeName.appid).toBe(1145360);
      expect(singleUnicodeName.owned).toBe(true);

      // 4. get_games_status mixed batch preserves per-index raw query across duplicates, AppIDs, URLs, languages, and errors
      const mixedQueries = [
        { query: '  Hades  ' },
        { query: 'Hades' },
        { query: '\u3000\tHades\u00a0' },
        { query: '  1145360  ' },
        { query: '\thttps://store.steampowered.com/app/1145360/Hades/\u3000' },
        { query: '1145360' },
        { query: '  1091500  ', language: '  zh-CN  ' },
        { query: '\u30001091500\t', language: 'en' },
        { query: '  赛博朋克2077  ', language: 'zh-CN', alternative_names: ['  Cyberpunk 2077  '] },
        { query: paddedRejectedUrl },
      ];
      const batch = GetGamesStatusOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'get_games_status',
            arguments: { queries: mixedQueries },
          })) as never,
        ),
      );
      expect(batch.total).toBe(mixedQueries.length);
      expect(batch.results.map((r) => r.query)).toEqual(mixedQueries.map((q) => q.query));
      expect(
        batch.results.map((r) => [r.resolution, r.appid, r.requested_language, r.name, r.owned, r.wishlisted]),
      ).toEqual([
        ['resolved', 1145360, 'english', 'Hades', true, false],
        ['resolved', 1145360, 'english', 'Hades', true, false],
        ['resolved', 1145360, 'english', 'Hades', true, false],
        ['resolved', 1145360, 'english', 'Hades', true, false],
        ['resolved', 1145360, 'english', 'Hades', true, false],
        ['resolved', 1145360, 'english', 'Hades', true, false],
        ['resolved', 1091500, 'schinese', '赛博朋克 2077', true, false],
        ['resolved', 1091500, 'english', 'Cyberpunk 2077', true, false],
        ['resolved', 1091500, 'schinese', '赛博朋克 2077', true, false],
        ['error', null, 'english', null, null, null],
      ]);
      expect(batch.results[9]?.error_code).toBe('invalid_query');

      // 5. Validation rejects empty, ASCII/Unicode whitespace-only, trimmed > 300, non-string, and blank language/alt names
      const invalidQueries: unknown[] = [
        '',
        '   \t\r\n ',
        '\u00a0\u3000\u2003\ufeff',
        'a'.repeat(301),
        `  ${'a'.repeat(301)}  `,
        1145360,
      ];
      for (const badQuery of invalidQueries) {
        const r1 = await client.callTool({
          name: 'resolve_game',
          arguments: { query: badQuery } as never,
        });
        expect(r1.isError, `resolve_game should reject ${JSON.stringify(badQuery)}`).toBe(true);

        const r2 = await client.callTool({
          name: 'get_game_status',
          arguments: { query: badQuery } as never,
        });
        expect(r2.isError, `get_game_status should reject ${JSON.stringify(badQuery)}`).toBe(true);

        const r3 = await client.callTool({
          name: 'get_games_status',
          arguments: { queries: [{ query: 'Hades' }, { query: badQuery }] } as never,
        });
        expect(r3.isError, `get_games_status should reject ${JSON.stringify(badQuery)}`).toBe(true);
      }

      const blankLang = await client.callTool({
        name: 'resolve_game',
        arguments: { query: 'Hades', language: '   ' },
      });
      expect(blankLang.isError).toBe(true);

      const blankAlt = await client.callTool({
        name: 'resolve_game',
        arguments: { query: 'Hades', alternative_names: ['\u3000\t'] },
      });
      expect(blankAlt.isError).toBe(true);

      expect(stderrChunks.join('')).not.toContain(TEST_STEAM_API_KEY);
    } finally {
      await client.close();
    }
  });

  it('supports list_owned_games sort_by appid and last_played with pagination over real stdio', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', PRELOAD_SCRIPT, DIST_ENTRY],
      env: {
        PATH: process.env['PATH'] ?? '',
        STEAM_API_KEY: TEST_STEAM_API_KEY,
        STEAM_ID: TEST_STEAM_ID,
        STEAM_COUNTRY: 'US',
        STEAM_LANGUAGE: 'english',
        E2E_MOCK_MODE: 'owned_sort',
      },
      stderr: 'pipe',
    });

    const client = new Client({ name: 'stdio-e2e-sort-client', version: '0.1.0' });
    await client.connect(transport);
    try {
      // Default and explicit appid order
      const defaultOwned = ListOwnedGamesOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'list_owned_games',
            arguments: { include_metadata: false },
          })) as never,
        ),
      );
      expect(defaultOwned.total).toBe(6);
      expect(defaultOwned.games.map((g) => g.appid)).toEqual([
        10, 1086940, 1091500, 1145350, 1145360, 1245620,
      ]);

      const explicitAppId = ListOwnedGamesOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'list_owned_games',
            arguments: { sort_by: 'appid', include_metadata: false },
          })) as never,
        ),
      );
      expect(explicitAppId.games.map((g) => g.appid)).toEqual(
        defaultOwned.games.map((g) => g.appid),
      );

      // last_played order: 1091500 (deduped 1700000900), tie 1700000500 (1086940 < 1145360),
      // then missing/0/malformed by AppID asc (10, 1145350, 1245620)
      const page1 = ListOwnedGamesOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'list_owned_games',
            arguments: { sort_by: 'last_played', offset: 0, limit: 2, include_metadata: true },
          })) as never,
        ),
      );
      expect(page1.total).toBe(6);
      expect(page1.has_more).toBe(true);
      expect(page1.games.map((g) => g.appid)).toEqual([1091500, 1086940]);
      expect(page1.games[0]).toMatchObject({
        appid: 1091500,
        name: 'Cyberpunk 2077',
        playtime_forever: 1200,
      });

      const page2 = ListOwnedGamesOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'list_owned_games',
            arguments: { sort_by: 'last_played', offset: 2, limit: 4, include_metadata: false },
          })) as never,
        ),
      );
      expect(page2.total).toBe(6);
      expect(page2.has_more).toBe(false);
      expect(page2.metadata_status).toBe('skipped');
      expect(page2.games.map((g) => g.appid)).toEqual([1145360, 10, 1145350, 1245620]);

      const badSort = await client.callTool({
        name: 'list_owned_games',
        arguments: { sort_by: 'playtime' } as never,
      });
      expect(badSort.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('supports list_owned_games sort_by playtime_asc and playtime_desc with pagination over real stdio', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', PRELOAD_SCRIPT, DIST_ENTRY],
      env: {
        PATH: process.env['PATH'] ?? '',
        STEAM_API_KEY: TEST_STEAM_API_KEY,
        STEAM_ID: TEST_STEAM_ID,
        STEAM_COUNTRY: 'US',
        STEAM_LANGUAGE: 'english',
        E2E_MOCK_MODE: 'owned_sort_playtime',
      },
      stderr: 'pipe',
    });

    const client = new Client({ name: 'stdio-e2e-playtime-sort-client', version: '0.1.0' });
    await client.connect(transport);
    try {
      // playtime_asc: 10 (0), tie 300 (1086940 < 1145360), 1091500 (deduped 1200),
      // then missing playtime by AppID asc (1145350, 1245620)
      const ascPage1 = ListOwnedGamesOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'list_owned_games',
            arguments: { sort_by: 'playtime_asc', offset: 0, limit: 2, include_metadata: true },
          })) as never,
        ),
      );
      expect(ascPage1.total).toBe(6);
      expect(ascPage1.has_more).toBe(true);
      expect(ascPage1.metadata_status).toBe('complete');
      expect(ascPage1.games.map((g) => [g.appid, g.name, g.playtime_forever])).toEqual([
        [10, 'Signal', 0],
        [1086940, "Baldur's Gate 3", 300],
      ]);

      const ascPage2 = ListOwnedGamesOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'list_owned_games',
            arguments: { sort_by: 'playtime_asc', offset: 2, limit: 4, include_metadata: false },
          })) as never,
        ),
      );
      expect(ascPage2.total).toBe(6);
      expect(ascPage2.has_more).toBe(false);
      expect(ascPage2.metadata_status).toBe('skipped');
      expect(ascPage2.games.map((g) => [g.appid, g.playtime_forever])).toEqual([
        [1145360, 300],
        [1091500, 1200],
        [1145350, null],
        [1245620, null],
      ]);

      // playtime_desc: 1091500 (1200), tie 300 (1086940 < 1145360), 10 (0),
      // then missing playtime by AppID asc (1145350, 1245620)
      const descPage1 = ListOwnedGamesOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'list_owned_games',
            arguments: { sort_by: 'playtime_desc', offset: 0, limit: 2, include_metadata: true },
          })) as never,
        ),
      );
      expect(descPage1.total).toBe(6);
      expect(descPage1.has_more).toBe(true);
      expect(descPage1.metadata_status).toBe('complete');
      expect(descPage1.games.map((g) => [g.appid, g.name, g.playtime_forever])).toEqual([
        [1091500, 'Cyberpunk 2077', 1200],
        [1086940, "Baldur's Gate 3", 300],
      ]);

      const descPage2 = ListOwnedGamesOutputSchema.parse(
        checkToolPayload(
          (await client.callTool({
            name: 'list_owned_games',
            arguments: { sort_by: 'playtime_desc', offset: 2, limit: 4, include_metadata: false },
          })) as never,
        ),
      );
      expect(descPage2.total).toBe(6);
      expect(descPage2.has_more).toBe(false);
      expect(descPage2.metadata_status).toBe('skipped');
      expect(descPage2.games.map((g) => [g.appid, g.playtime_forever])).toEqual([
        [1145360, 300],
        [10, 0],
        [1145350, null],
        [1245620, null],
      ]);
    } finally {
      await client.close();
    }
  });
});
