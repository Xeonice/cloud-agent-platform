import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  API_KEY_PREFIX,
  ApiKeyListItemSchema,
  ApiKeyMintRequestSchema,
  McpTokenListItemSchema,
  McpTokenMintRequestSchema,
  ScopeSchema,
} = require(path.join(here, '..', 'dist', 'index.js'));

const id = '11111111-1111-4111-8111-111111111111';

test('shared grantable vocabulary includes an independent tasks:diagnostics scope', () => {
  assert.deepEqual(ScopeSchema.options, [
    'tasks:read',
    'tasks:write',
    'tasks:diagnostics',
    'repos:read',
  ]);
  assert.equal(ScopeSchema.parse('tasks:diagnostics'), 'tasks:diagnostics');
  assert.equal(ScopeSchema.safeParse('tasks:*').success, false);
});

test('API-key and MCP-token mint contracts accept an explicit diagnostics grant', () => {
  assert.deepEqual(
    ApiKeyMintRequestSchema.parse({
      name: 'diagnostics reader',
      scopes: ['tasks:diagnostics'],
    }).scopes,
    ['tasks:diagnostics'],
  );
  assert.deepEqual(
    McpTokenMintRequestSchema.parse({
      name: 'diagnostics MCP client',
      scopes: ['tasks:read', 'tasks:diagnostics'],
    }).scopes,
    ['tasks:read', 'tasks:diagnostics'],
  );
});

test('existing scoped credential projections preserve exactly their stored grants', () => {
  const apiKey = ApiKeyListItemSchema.parse({
    id,
    name: 'existing API key',
    scopes: ['tasks:read', 'tasks:write'],
    prefix: API_KEY_PREFIX,
    last4: 'abcd',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  });
  const mcpToken = McpTokenListItemSchema.parse({
    id,
    name: 'existing MCP token',
    scopes: ['tasks:read'],
    prefix: 'mcp_',
    last4: 'wxyz',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  });

  assert.deepEqual(apiKey.scopes, ['tasks:read', 'tasks:write']);
  assert.equal(apiKey.scopes.includes('tasks:diagnostics'), false);
  assert.deepEqual(mcpToken.scopes, ['tasks:read']);
  assert.equal(mcpToken.scopes.includes('tasks:diagnostics'), false);
});
