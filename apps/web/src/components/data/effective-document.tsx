'use client';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/**
 * The YAML this node will actually be served (#143).
 *
 * Read from disk, not re-rendered — so what is shown is what
 * `nexuspuppet-enc.sh` will `cat`, byte for byte. Everything else on this
 * screen describes this file; showing the file is what makes the rest
 * trustworthy, and it is what an operator pastes into a ticket.
 */
export function EffectiveDocument({
  document,
  usesDefault,
  materialization,
  pending,
}: {
  document: string | null;
  usesDefault: boolean;
  materialization: { contentHash: string; revision: number; relativePath: string } | null;
  pending: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Effective document</CardTitle>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            The hash and revision belong to the bytes below, so a view that has
            gone stale is detectable rather than merely wrong.
          */}
          {materialization !== null && <Badge>rev {materialization.revision}</Badge>}
          {pending && <span className="text-[11px] text-state-pending">queued</span>}
        </div>
      </CardHeader>

      {usesDefault ? (
        <p className="px-3 py-2 text-xs text-ink-muted">
          {'This node has no file of its own, so it receives '}
          <code className="font-mono">default.yaml</code>
          {'. That is a valid classification, not a fault — an unmatched node gets a defined, '}
          {'safe result rather than a failed compile.'}
        </p>
      ) : (
        <>
          {/*
            Monospace and its own scroll container. Proportional type destroys
            the column alignment that makes nested YAML legible, and a wide
            document must never make the page body scroll horizontally.
          */}
          <div className="overflow-x-auto px-3 py-2">
            <pre className="whitespace-pre font-mono text-[11px] leading-relaxed text-ink">
              {document}
            </pre>
          </div>

          {materialization !== null && (
            <p className="border-t border-line px-3 py-1.5 font-mono text-[11px] text-ink-faint">
              {materialization.relativePath} · {materialization.contentHash.slice(0, 12)}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
