<!-- Single-file change to the live DockerUpdaterLauncher; one serial track. -->

## 1. Track: ensure-updater-image (depends: none)

- [x] 1.1 Add a private `ensureImage(image)` to `DockerUpdaterLauncher` (`apps/api/src/self-update/self-update.service.ts`): `getImage(image).inspect()` first, return on success; on a thrown error, `docker.pull(image)` and await completion via `docker.modem.followProgress`.
- [x] 1.2 Call `await this.ensureImage(image)` in `launch()` immediately before `createContainer`, with a comment explaining that `createContainer` never auto-pulls.
- [x] 1.3 Verify `pnpm --filter @cap/api typecheck` and lint pass for the edited file.
