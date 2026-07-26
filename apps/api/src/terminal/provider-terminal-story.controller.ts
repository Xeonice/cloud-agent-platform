import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ProviderTerminalStoryService,
  type CreateProviderTerminalStorySessionInput,
  type ProviderTerminalStoryReadiness,
  type ProviderTerminalStoryInventoryView,
  type ProviderTerminalStorySessionView,
} from './provider-terminal-story.service';

@Controller('terminal-stories/provider')
export class ProviderTerminalStoryController {
  constructor(private readonly stories: ProviderTerminalStoryService) {}

  @Get()
  readiness(
    @Query('provider') provider?: string,
  ): Promise<ProviderTerminalStoryReadiness> {
    return this.stories.readiness(provider);
  }

  @Post('sessions')
  async create(
    @Body() body?: CreateProviderTerminalStorySessionInput,
    @Req() request?: Request,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<ProviderTerminalStorySessionView> {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    let listeningToRequest = false;
    let listeningToResponse = false;
    if (request?.aborted || response?.destroyed) {
      cancellation.abort();
    } else {
      request?.once('aborted', abort);
      response?.once('close', abort);
      listeningToRequest = request !== undefined;
      listeningToResponse = response !== undefined;
    }
    try {
      return await this.stories.createSession(body ?? {}, cancellation.signal);
    } finally {
      if (listeningToRequest) request?.off('aborted', abort);
      if (listeningToResponse) response?.off('close', abort);
    }
  }

  @Get('sessions/:sessionId')
  get(@Param('sessionId') sessionId: string): ProviderTerminalStorySessionView {
    return this.stories.getSession(sessionId);
  }

  @Get('sessions/:sessionId/inventory')
  inventory(
    @Param('sessionId') sessionId: string,
  ): ProviderTerminalStoryInventoryView {
    return this.stories.getInventory(sessionId);
  }

  @Delete('sessions/:sessionId')
  delete(
    @Param('sessionId') sessionId: string,
  ): Promise<ProviderTerminalStorySessionView> {
    return this.stories.teardownSession(sessionId);
  }
}
