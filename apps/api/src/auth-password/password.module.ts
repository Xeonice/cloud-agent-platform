import { Module } from '@nestjs/common';
import { PasswordAuthService } from './password.service';
import { PasswordController } from './password.controller';

/**
 * Email + password login module (add-private-account-identity, tasks 4.1 / 4.2).
 *
 * Wires {@link PasswordController} (`/auth/password`, `/auth/change-password`) and
 * {@link PasswordAuthService}. Relies on the global `PrismaModule` for DB access;
 * password hashing/verification is the shared `auth/argon2` util. Registered in
 * `app.module.ts` (the single module-graph writer).
 */
@Module({
  controllers: [PasswordController],
  providers: [PasswordAuthService],
  exports: [PasswordAuthService],
})
export class PasswordModule {}
