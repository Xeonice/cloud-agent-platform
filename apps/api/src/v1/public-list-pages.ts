import {
  V1ListReposResponseSchema,
  V1ListTasksResponseSchema,
  repoResponseSchema,
  taskResponseSchema,
  type V1ListQuery,
  type V1ListReposResponse,
  type V1ListTasksResponse,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildPage,
  cursorWhere,
  decodeCursor,
  KEYSET_ORDER_BY,
  resolveLimit,
} from './keyset-pagination';

/** Shared `/v1`/MCP task-page read so both machine surfaces have identical paging. */
export async function listTaskPage(
  prisma: PrismaService,
  query: V1ListQuery,
): Promise<V1ListTasksResponse> {
  const limit = resolveLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const rows = await prisma.task.findMany({
    where: cursorWhere(cursor),
    orderBy: KEYSET_ORDER_BY,
    take: limit + 1,
  });
  const page = buildPage(rows, limit);
  return V1ListTasksResponseSchema.parse({
    items: page.items.map((row) => taskResponseSchema.parse(row)),
    nextCursor: page.nextCursor,
  });
}

/** Shared `/v1`/MCP repo-page read so both machine surfaces have identical paging. */
export async function listRepoPage(
  prisma: PrismaService,
  query: V1ListQuery,
): Promise<V1ListReposResponse> {
  const limit = resolveLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const rows = await prisma.repo.findMany({
    where: cursorWhere(cursor),
    orderBy: KEYSET_ORDER_BY,
    take: limit + 1,
  });
  const page = buildPage(rows, limit);
  return V1ListReposResponseSchema.parse({
    items: page.items.map((row) => repoResponseSchema.parse(row)),
    nextCursor: page.nextCursor,
  });
}
