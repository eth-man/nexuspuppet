import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  addPinsSchema,
  assignClassSchema,
  createNodeGroupSchema,
  puppetClassNameSchema,
  replaceRulesSchema,
  setParameterSchema,
  updateNodeGroupSchema,
  type AddPins,
  type AssignClass,
  type ClassificationWriteResult,
  type CreateNodeGroup,
  type NodeGroupDetail,
  type ReplaceRules,
  type SetParameter,
  type UpdateNodeGroup,
  type FactPathIndex,
  planRequestSchema,
  type PlanRequest,
  type PlanResponse,
} from '@nexuspuppet/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission, type AuthenticatedRequest } from '../auth/auth.guard';
import { ClassificationPlanner } from './plan/classification-planner.service';
import { ClassificationService, type AuditContext } from './classification.service';

/**
 * Node group CRUD (ADR-0009).
 *
 * Writes answer **202 Accepted**, never 200. The change is durable at commit
 * but not yet effective — the ENC file is written asynchronously (ADR-0003).
 * Answering 200 would tell the UI the estate is already configured this way,
 * which would be a correctness bug rather than a cosmetic one. The response
 * names exactly which nodes were queued so the UI can show per-node progress.
 */
@Controller('node-groups')
export class NodeGroupsController {
  constructor(private readonly classification: ClassificationService) {}

  @RequirePermission('classification:read')
  @Get()
  list(): Promise<NodeGroupDetail[]> {
    return this.classification.list();
  }

  @RequirePermission('classification:read')
  @Get(':id')
  get(@Param('id') id: string): Promise<NodeGroupDetail> {
    return this.classification.get(id);
  }

  @RequirePermission('classification:write')
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(
    @Body(new ZodValidationPipe(createNodeGroupSchema)) body: CreateNodeGroup,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClassificationWriteResult> {
    return this.classification.create(body, principalOf(request), contextOf(request));
  }

  @RequirePermission('classification:write')
  @Patch(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateNodeGroupSchema)) body: UpdateNodeGroup,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClassificationWriteResult> {
    return this.classification.update(id, body, principalOf(request), contextOf(request));
  }

  @RequirePermission('classification:write')
  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  remove(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ materializationQueued: { scope: 'nodes'; certnames: string[] } }> {
    return this.classification.remove(id, principalOf(request), contextOf(request));
  }

  /**
   * Replace the whole rule set.
   *
   * A set replacement rather than per-rule CRUD, so an edit that adds one rule
   * and removes another is a single atomic change. Applying them separately
   * would materialize an intermediate classification that the operator never
   * asked for — briefly configuring real machines from a state that never
   * existed in anyone's intent.
   */
  @RequirePermission('classification:write')
  @Put(':id/rules')
  @HttpCode(HttpStatus.ACCEPTED)
  replaceRules(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(replaceRulesSchema)) body: ReplaceRules,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClassificationWriteResult> {
    return this.classification.replaceRules(id, body, principalOf(request), contextOf(request));
  }

  @RequirePermission('classification:write')
  @Put(':id/classes')
  @HttpCode(HttpStatus.ACCEPTED)
  assignClass(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignClassSchema)) body: AssignClass,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClassificationWriteResult> {
    return this.classification.assignClass(id, body, principalOf(request), contextOf(request));
  }

  @RequirePermission('classification:write')
  @Delete(':id/classes/:className')
  @HttpCode(HttpStatus.ACCEPTED)
  removeClass(
    @Param('id') id: string,
    @Param('className', new ZodValidationPipe(puppetClassNameSchema)) className: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClassificationWriteResult> {
    return this.classification.removeClass(id, className, principalOf(request), contextOf(request));
  }

  @RequirePermission('classification:write')
  @Put(':id/parameters')
  @HttpCode(HttpStatus.ACCEPTED)
  setParameter(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setParameterSchema)) body: SetParameter,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClassificationWriteResult> {
    return this.classification.setParameter(id, body, principalOf(request), contextOf(request));
  }

  @RequirePermission('classification:write')
  @Delete(':id/parameters/:key')
  @HttpCode(HttpStatus.ACCEPTED)
  removeParameter(
    @Param('id') id: string,
    @Param('key') key: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClassificationWriteResult> {
    return this.classification.removeParameter(id, key, principalOf(request), contextOf(request));
  }

  @RequirePermission('classification:write')
  @Post(':id/pins')
  @HttpCode(HttpStatus.ACCEPTED)
  addPins(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addPinsSchema)) body: AddPins,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClassificationWriteResult> {
    return this.classification.addPins(
      id,
      body.certnames,
      principalOf(request),
      contextOf(request),
    );
  }

  @RequirePermission('classification:write')
  @Delete(':id/pins/:certname')
  @HttpCode(HttpStatus.ACCEPTED)
  removePin(
    @Param('id') id: string,
    @Param('certname') certname: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClassificationWriteResult> {
    return this.classification.removePin(id, certname, principalOf(request), contextOf(request));
  }
}

/**
 * Materialization control and the "why is this node classified this way?" view.
 *
 * Separate controller because these are not node-group resources, and the
 * reconcile trigger needs a different permission from classification edits.
 */
@Controller()
export class MaterializationController {
  constructor(
    private readonly classification: ClassificationService,
    private readonly planner: ClassificationPlanner,
  ) {}

  /**
   * Fact paths available to matching rules.
   *
   * Read permission, not write: an operator reviewing why a group matches
   * nothing needs to see which facts exist without being able to change them.
   */
  @RequirePermission('classification:read')
  @Get('fact-paths')
  factPaths(): Promise<FactPathIndex> {
    return this.classification.listFactPaths();
  }

  /**
   * What a change would do, without doing it.
   *
   * A POST because the body is the change being previewed, not because anything
   * is written — nothing here touches the database or the ENC directory. Gated
   * on `classification:write` rather than `:read`: the body is a write request,
   * and a plan reveals the estate-wide consequence of one. Someone who may not
   * make the change has no business rehearsing it.
   */
  @RequirePermission('classification:write')
  @Post('classification/plan')
  @HttpCode(HttpStatus.OK)
  plan(
    @Body(new ZodValidationPipe(planRequestSchema)) request: PlanRequest,
  ): Promise<PlanResponse> {
    return this.planner.plan(request);
  }

  @RequirePermission('materialization:trigger')
  @Post('materialization/reconcile')
  @HttpCode(HttpStatus.ACCEPTED)
  async reconcile(@Req() request: AuthenticatedRequest): Promise<{ queued: true }> {
    await this.classification.forceReconcile(principalOf(request), contextOf(request));
    return { queued: true };
  }
}

function principalOf(
  request: AuthenticatedRequest,
): NonNullable<AuthenticatedRequest['principal']> {
  // AuthGuard populates this before any handler runs; absence means the guard
  // was bypassed, which must fail rather than proceed anonymously.
  if (request.principal === undefined) throw new UnauthorizedException();
  return request.principal;
}

function contextOf(request: AuthenticatedRequest): AuditContext {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null,
  };
}
