import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import {
  CreateSandboxEnvironmentRequestSchema,
  UpdateSandboxEnvironmentParametersRequestSchema,
  type CreateSandboxEnvironmentRequest,
  type ListSandboxEnvironmentValidationsResponse,
  type ListSandboxEnvironmentsResponse,
  type SandboxEnvironmentResponse,
  type UpdateSandboxEnvironmentParametersRequest,
  type ValidateSandboxEnvironmentResponse,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { SandboxEnvironmentsService } from './sandbox-environments.service';

@Controller('sandbox-environments')
export class SandboxEnvironmentsController {
  constructor(
    private readonly environments: SandboxEnvironmentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(): Promise<ListSandboxEnvironmentsResponse> {
    return { environments: await this.environments.list() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(CreateSandboxEnvironmentRequestSchema))
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateSandboxEnvironmentRequest,
  ): Promise<SandboxEnvironmentResponse> {
    await this.requireAdmin(req);
    return this.environments.create(body);
  }

  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  async validate(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ValidateSandboxEnvironmentResponse> {
    await this.requireAdmin(req);
    return this.environments.validate(id);
  }

  @Patch(':id/parameters')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(UpdateSandboxEnvironmentParametersRequestSchema))
  async updateParameters(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateSandboxEnvironmentParametersRequest,
  ): Promise<SandboxEnvironmentResponse> {
    await this.requireAdmin(req);
    return this.environments.updateParameters(id, body);
  }

  @Patch(':id/default')
  @HttpCode(HttpStatus.OK)
  async setDefault(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<SandboxEnvironmentResponse> {
    await this.requireAdmin(req);
    return this.environments.setDefault(id);
  }

  @Patch(':id/retire')
  @HttpCode(HttpStatus.OK)
  async retire(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<SandboxEnvironmentResponse> {
    await this.requireAdmin(req);
    return this.environments.retire(id);
  }

  @Get(':id/validations')
  async validations(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ListSandboxEnvironmentValidationsResponse> {
    await this.requireAdmin(req);
    return { validations: await this.environments.listValidations(id) };
  }

  private async requireAdmin(req: AuthenticatedRequest): Promise<void> {
    const principal = req.operatorPrincipal;
    const user = principal?.user;
    if (!principal || !user) throw this.adminDenied();

    const where = resolveAccountWhere(user);
    if (where === null) throw this.adminDenied();

    const account = await this.prisma.user.findUnique({
      where,
      select: { role: true, allowed: true },
    });
    if (!account || account.allowed !== true || account.role !== 'admin') {
      throw this.adminDenied();
    }
  }

  private adminDenied(): ForbiddenException {
    return new ForbiddenException({
      error: 'admin_required',
      message: 'Sandbox environment management requires an admin account.',
    });
  }
}

function resolveAccountWhere(
  user: { id?: string; githubId?: number | null },
): { id: string } | { githubId: number } | null {
  if (typeof user.id === 'string' && user.id.length > 0) return { id: user.id };
  if (typeof user.githubId === 'number') return { githubId: user.githubId };
  return null;
}
