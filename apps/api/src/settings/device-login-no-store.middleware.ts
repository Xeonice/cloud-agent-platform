import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Runs before guards so even authentication/authorization failures for the
 * short-lived device-login surface cannot be cached by a browser or proxy.
 */
@Injectable()
export class DeviceLoginNoStoreMiddleware implements NestMiddleware {
  use(_request: Request, response: Response, next: NextFunction): void {
    response.setHeader('Cache-Control', 'no-store');
    next();
  }
}
