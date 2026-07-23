/**
 * add-repo-content-store — the import flows must actually REACH the repo-store.
 *
 * The prior attempt at this change died as "built but unreachable": the pieces
 * existed, nothing wired them together. This spec compiles the real
 * {@link ReposModule} (with only the global Prisma provider faked) so a missing
 * import, a forgotten provider, or an unregistered controller fails here instead
 * of at deploy time.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Global, Module } from '@nestjs/common';
import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { RepoStoreService } from '../repo-store/repo-store.service';
import { LocalRepoImportService } from './local-import.service';
import { RepoCopyController } from './repo-copy.controller';
import { RepoCopyService } from './repo-copy.service';
import { ReposModule } from './repos.module';
import { ReposService } from './repos.service';

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: {} }],
  exports: [PrismaService],
})
class FakeGlobalPrismaModule {}

test('ReposModule wires the content-copy seam end to end', async () => {
  const controllers = Reflect.getMetadata(
    MODULE_METADATA.CONTROLLERS,
    ReposModule,
  ) as unknown[];
  assert.ok(
    controllers.includes(RepoCopyController),
    'the copy/local-import controller is registered',
  );

  const moduleRef = await Test.createTestingModule({
    imports: [FakeGlobalPrismaModule, ReposModule],
  }).compile();
  try {
    // Every import path can reach acquisition, and acquisition reaches the store.
    assert.ok(moduleRef.get(ReposService));
    assert.ok(moduleRef.get(RepoCopyService));
    assert.ok(moduleRef.get(LocalRepoImportService));
    assert.ok(moduleRef.get(RepoStoreService, { strict: false }));
    assert.ok(moduleRef.get(RepoCopyController));
  } finally {
    await moduleRef.close();
  }
});

test('the console-internal copy routes mount under /repos', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, RepoCopyController), 'repos');
  const paths = ['availability', 'importLocal', 'refreshCopy'].map((method) =>
    Reflect.getMetadata(
      PATH_METADATA,
      RepoCopyController.prototype[
        method as 'availability' | 'importLocal' | 'refreshCopy'
      ],
    ),
  );
  assert.deepEqual(paths, [
    'local-import/availability',
    'local-import',
    ':repoId/refresh-copy',
  ]);
});
