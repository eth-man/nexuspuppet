'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Minus, Plus } from 'lucide-react';
import type { PlanFieldChange, PlanRequest, PlanResponse, PlanShape } from '@nexuspuppet/contracts';
import { api } from '@/lib/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/**
 * "Plan before apply" — the review step between Save and the write.
 *
 * ONE dialog for the whole page rather than one per editor. Rules, classes,
 * parameters, pins and group settings each have their own save button, and five
 * copies of this would be five chances for them to disagree about what a review
 * looks like.
 *
 * The write itself is unchanged: `review()` takes the same mutation the button
 * used to call directly and runs it on confirm. Nothing about the apply path
 * moves, so a bug here cannot corrupt a write — it can only fail to preview one.
 */

interface PendingReview {
  request: PlanRequest;
  /** The write the operator was about to make, deferred until they confirm. */
  apply: () => void;
  /** What is being changed, for the dialog's title. */
  label: string;
}

interface PlanReviewContext {
  review: (request: PlanRequest, label: string, apply: () => void) => void;
}

const Context = createContext<PlanReviewContext | null>(null);

export function usePlanReview(): PlanReviewContext {
  const context = useContext(Context);
  if (context === null) throw new Error('usePlanReview requires <PlanReviewProvider>');
  return context;
}

export function PlanReviewProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingReview | null>(null);

  const plan = useMutation<PlanResponse, Error, PlanRequest>({
    mutationFn: (request) => api.post<PlanResponse>('/classification/plan', request),
  });

  const review = useCallback(
    (request: PlanRequest, label: string, apply: () => void) => {
      setPending({ request, apply, label });
      plan.mutate(request);
    },
    [plan],
  );

  const close = useCallback(() => {
    setPending(null);
    plan.reset();
  }, [plan]);

  const value = useMemo(() => ({ review }), [review]);

  return (
    <Context.Provider value={value}>
      {children}
      {pending !== null && (
        <ReviewDialog
          label={pending.label}
          plan={plan.data}
          isPending={plan.isPending}
          error={plan.error}
          onCancel={close}
          onApply={() => {
            const { apply } = pending;
            close();
            apply();
          }}
        />
      )}
    </Context.Provider>
  );
}

function ReviewDialog({
  label,
  plan,
  isPending,
  error,
  onCancel,
  onApply,
}: {
  label: string;
  plan: PlanResponse | undefined;
  isPending: boolean;
  error: Error | null;
  onCancel: () => void;
  onApply: () => void;
}) {
  // Focused on mount, so the default action of this dialog is NOT to proceed.
  // It exists to make it easy to decide against a change.
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Review change"
      description={label}
      className="max-w-3xl"
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" size="sm" autoFocus onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            // A failed plan must not become a blocked change: the operator can
            // still apply, they just do it without a preview. Refusing would
            // make a preview outage an outage of the product.
            disabled={isPending}
            onClick={onApply}
          >
            {error !== null ? 'Apply without preview' : 'Apply change'}
          </Button>
        </>
      }
    >
      {isPending && <p className="text-xs text-ink-muted">Working out what this would do…</p>}

      {error !== null && (
        <p className="text-xs text-state-pending">
          Could not preview this change: {error.message}. You can still apply it.
        </p>
      )}

      {plan !== undefined && <PlanBody plan={plan} />}
    </Dialog>
  );
}

function PlanBody({ plan }: { plan: PlanResponse }) {
  const { counts } = plan;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-lg tabular-nums text-ink">{counts.total}</span>
        <span className="text-xs text-ink-muted">node{counts.total === 1 ? '' : 's'} affected</span>
        <span className="font-mono text-xs tabular-nums text-ink-faint">
          {counts.unchanged} unchanged
        </span>
      </div>

      {counts.total === 0 ? (
        // Worth saying plainly. "No nodes change" is a legitimate and common
        // outcome — a group with no members yet, or a value that already matches
        // — and silence would read as a broken preview.
        <p className="text-xs text-ink-muted">
          This change affects no nodes today. It will apply to any node that matches later.
        </p>
      ) : (
        <div className="flex flex-wrap gap-x-4 text-xs">
          {counts.added > 0 && (
            <span className="text-state-changed">+{counts.added} newly classified</span>
          )}
          {counts.removed > 0 && (
            <span className="text-state-failed">−{counts.removed} no longer classified</span>
          )}
          {counts.changed > 0 && <span className="text-ink-muted">{counts.changed} changed</span>}
        </div>
      )}

      {plan.truncated && (
        <p className="flex items-start gap-1.5 rounded border border-state-pending/40 bg-state-pending/5 p-2 text-[11px] text-state-pending">
          <AlertTriangle className="mt-px shrink-0" size={13} aria-hidden />
          <span>
            <strong>Sampled.</strong> This estate has {plan.estateSize} nodes and this preview
            examined {plan.evaluated}. The real change may affect nodes not shown here.
          </span>
        </p>
      )}

      {/* Above the diff on purpose: a new conflict is more likely to stop
          someone than the diff itself. */}
      {plan.conflictsIntroduced.length > 0 && (
        <div className="rounded border border-state-pending/40 bg-state-pending/5 p-2">
          <p className="mb-1 text-[11px] font-medium text-state-pending">
            {plan.conflictsIntroduced.length} new conflict
            {plan.conflictsIntroduced.length === 1 ? '' : 's'}
          </p>
          <ul className="space-y-0.5">
            {plan.conflictsIntroduced.slice(0, 5).map((conflict) => (
              <li key={`${conflict.key}-${conflict.winningGroupId}`} className="text-[11px]">
                <span className="font-mono text-ink">{conflict.key}</span>
                <span className="text-ink-faint">
                  {' '}
                  — {conflict.winningGroupName} overrides {conflict.losingGroupName}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.shapes.map((shape, index) => (
        <ShapeBlock key={`${shape.exemplar}-${index}`} shape={shape} defaultOpen={index === 0} />
      ))}

      {plan.warnings.length > 0 && (
        <ul className="space-y-0.5">
          {plan.warnings.map((warning) => (
            <li key={warning} className="text-[11px] text-state-pending">
              {warning}
            </li>
          ))}
        </ul>
      )}

      {/* The honest caveat. A plan is computed against the estate as it is now;
          a node checking in between here and Apply changes the outcome. */}
      <p className="border-t border-line pt-2 text-[11px] text-ink-faint">
        Forecast based on the current estate state.
      </p>
    </div>
  );
}

/**
 * One distinct outcome and the nodes that share it.
 *
 * Only the first is expanded. Most changes have one dominant shape, and opening
 * all of them turns a summary back into the wall of diffs that grouping exists
 * to avoid.
 */
function ShapeBlock({ shape, defaultOpen }: { shape: PlanShape; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded border border-line-soft">
      <button
        type="button"
        className="flex w-full items-center justify-between px-2 py-1.5 text-left"
        onClick={() => setOpen((current) => !current)}
      >
        {/* "25 nodes · e.g. app02" was read as "25 nodes called app02" by
              someone using it. `e.g.` is doing too much work in a dense line,
              and the ambiguity is worst for the person who most needs the
              preview: someone reviewing an estate they did not build. Naming
              one node and counting the rest cannot be misread. */}
        <span className="text-xs text-ink">
          <span className="font-mono tabular-nums">{shape.count}</span> node
          {shape.count === 1 ? '' : 's'} change this way
          <span className="text-ink-faint"> — </span>
          <span className="font-mono text-[11px]">{shape.exemplar}</span>
          {shape.count > 1 && (
            <span className="text-ink-faint">
              {' '}
              and {shape.count - 1} other{shape.count === 2 ? '' : 's'}
            </span>
          )}
        </span>
        <span className="text-[11px] text-ink-faint">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="space-y-1 border-t border-line-soft px-2 py-1.5 font-mono text-[11px]">
          {shape.diff.classesAdded.map((className) => (
            <Line key={`+${className}`} tone="added" text={className} />
          ))}
          {shape.diff.classesRemoved.map((className) => (
            <Line key={`-${className}`} tone="removed" text={className} />
          ))}
          {shape.diff.classParameters.map((change) => (
            <ParamLine key={`${change.className}.${change.key}`} change={change} />
          ))}
          {shape.diff.parameters.map((change) => (
            <ParamLine key={change.key} change={change} />
          ))}
          {shape.diff.environmentBefore !== shape.diff.environmentAfter && (
            <p className="text-ink-muted">
              environment{' '}
              <span className="text-state-failed">{shape.diff.environmentBefore ?? '(none)'}</span>{' '}
              <ArrowRight className="inline" size={10} aria-hidden />{' '}
              <span className="text-state-changed">{shape.diff.environmentAfter ?? '(none)'}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Line({ tone, text }: { tone: 'added' | 'removed'; text: string }) {
  const Icon = tone === 'added' ? Plus : Minus;
  return (
    <p className={cn(tone === 'added' ? 'text-state-changed' : 'text-state-failed')}>
      <Icon className="inline" size={10} aria-hidden /> {text}
    </p>
  );
}

/** Named field, before and after — not a text diff of the rendered YAML. */
function ParamLine({ change }: { change: PlanFieldChange }) {
  return (
    <p className="text-ink-muted">
      {change.className !== undefined && (
        <span className="text-ink-faint">{change.className}.</span>
      )}
      {change.key}{' '}
      <span className="text-state-failed">{JSON.stringify(change.before) ?? 'null'}</span>{' '}
      <ArrowRight className="inline" size={10} aria-hidden />{' '}
      <span className="text-state-changed">{JSON.stringify(change.after) ?? 'null'}</span>
    </p>
  );
}
