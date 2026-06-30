import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  ProviderTerminalStoryService,
  type CreateProviderTerminalStorySessionInput,
  type ProviderTerminalStoryReadiness,
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
  create(
    @Body() body?: CreateProviderTerminalStorySessionInput,
  ): Promise<ProviderTerminalStorySessionView> {
    return this.stories.createSession(body ?? {});
  }

  @Get('sessions/:sessionId')
  get(@Param('sessionId') sessionId: string): ProviderTerminalStorySessionView {
    return this.stories.getSession(sessionId);
  }

  @Delete('sessions/:sessionId')
  delete(
    @Param('sessionId') sessionId: string,
  ): Promise<ProviderTerminalStorySessionView> {
    return this.stories.teardownSession(sessionId);
  }
}
