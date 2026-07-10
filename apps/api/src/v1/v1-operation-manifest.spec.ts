import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import { RequestMethod, type Type } from '@nestjs/common';
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { PUBLIC_V1_OPERATIONS } from '@cap/contracts';

import { V1Module } from './v1.module';

/**
 * `/internal/sandbox/approvals` is a sandbox hook callback, not the public
 * operator API. It is owned by TerminalModule and intentionally excluded from
 * both V1Module and the public operation manifest.
 */
const INTERNAL_ROUTE_KEYS = new Set([
  'POST /internal/sandbox/approvals',
]);

const REQUEST_METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.SEARCH]: 'SEARCH',
};

function metadataPaths(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [''];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(metadataPaths);
  throw new TypeError(`Unsupported Nest path metadata: ${String(value)}`);
}

function joinRoutePath(controllerPath: string, handlerPath: string): string {
  const segments = [controllerPath, handlerPath]
    .flatMap((value) => value.split('/'))
    .filter(Boolean);
  return `/${segments.join('/')}`.replace(/:([^/]+)/g, '{$1}');
}

function reflectedRouteKeys(controllers: readonly Type<unknown>[]): string[] {
  const keys: string[] = [];

  for (const controller of controllers) {
    const controllerPaths = metadataPaths(
      Reflect.getMetadata(PATH_METADATA, controller),
    );
    const prototype = controller.prototype as Record<string, unknown>;

    for (const propertyName of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[propertyName];
      if (typeof handler !== 'function') continue;

      const requestMethod = Reflect.getMetadata(
        METHOD_METADATA,
        handler,
      ) as RequestMethod | undefined;
      if (requestMethod === undefined) continue;

      const methodName = REQUEST_METHOD_NAMES[requestMethod];
      assert.ok(
        methodName,
        `${controller.name}.${propertyName} uses an unsupported public HTTP method`,
      );
      const handlerPaths = metadataPaths(
        Reflect.getMetadata(PATH_METADATA, handler),
      );

      for (const controllerPath of controllerPaths) {
        for (const handlerPath of handlerPaths) {
          keys.push(
            `${methodName} ${joinRoutePath(controllerPath, handlerPath)}`,
          );
        }
      }
    }
  }

  return keys.sort();
}

test('PUBLIC_V1_OPERATIONS exactly matches the real V1Module controller decorators', () => {
  const controllers = Reflect.getMetadata(
    MODULE_METADATA.CONTROLLERS,
    V1Module,
  ) as Type<unknown>[] | undefined;
  assert.ok(controllers, 'V1Module declares its public controllers');

  const actual = reflectedRouteKeys(controllers);
  const expected = PUBLIC_V1_OPERATIONS.map(
    (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
  ).sort();

  assert.equal(expected.length, 17, 'the public data manifest contains 17 operations');
  assert.equal(new Set(expected).size, expected.length, 'manifest route keys are unique');
  assert.equal(new Set(actual).size, actual.length, 'controller route keys are unique');
  assert.deepEqual(
    actual,
    expected,
    'a controller route and its public contract must be added or removed together',
  );

  for (const internalRoute of INTERNAL_ROUTE_KEYS) {
    assert.ok(
      !actual.includes(internalRoute),
      `${internalRoute} is internal and must not enter V1Module/public OpenAPI`,
    );
    assert.ok(
      !expected.includes(internalRoute),
      `${internalRoute} is internal and must not enter PUBLIC_V1_OPERATIONS`,
    );
  }
});
