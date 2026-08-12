'use client';

import { useRef, useState, type DragEvent } from 'react';
import { FileCheck2, Upload, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * A PEM file, by drop or by browse, with pasting kept for people who want it.
 *
 * Two five-row textareas side by side is what this was, and it asked the
 * operator to do the one thing nobody does willingly: open a certificate in a
 * text editor, select all of it including the banner lines, and paste it into a
 * box that shows a fifth of it. The file is already on their disk. Reading it
 * here is the same bytes with none of the ceremony.
 *
 * The value stays a STRING either way, so nothing downstream learns that a file
 * was involved — the installer receives exactly what it received before.
 *
 * Paste survives because it is genuinely better in two cases: copying a chain
 * out of a password manager or a ticket, and a browser session on a machine
 * that is not the one holding the file.
 */
export function PemInput({
  label,
  accept,
  value,
  onChange,
  placeholder,
  constraints,
  tooltip,
}: {
  label: string;
  /** File extensions offered in the picker. Not a validation. */
  accept: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  /** Short, absolute requirements. Rendered as muted bullets, not prose. */
  constraints: readonly string[];
  tooltip?: React.ReactNode;
}) {
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [filename, setFilename] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const take = async (file: File | undefined) => {
    setProblem(null);
    if (file === undefined) return;

    /*
     * Guarded because this reads as TEXT. A DER certificate or a keystore
     * dropped here would decode to mojibake and be sent to the installer,
     * which would reject it with a parse error that says nothing about the
     * actual mistake — that the file is not PEM.
     */
    if (file.size > 512 * 1024) {
      setProblem('That file is too large to be a PEM certificate or key.');
      return;
    }

    const text = await file.text();
    if (!text.includes('-----BEGIN')) {
      setProblem(`${file.name} does not look like PEM. It should start with "-----BEGIN".`);
      return;
    }

    setFilename(file.name);
    onChange(text);
  };

  const clear = () => {
    setFilename(null);
    setProblem(null);
    onChange('');
    if (picker.current !== null) picker.current.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void take(event.dataTransfer.files[0]);
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Label>{label}</Label>
          {tooltip}
        </div>
        <button
          type="button"
          onClick={() => setMode(mode === 'file' ? 'paste' : 'file')}
          className="text-2xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
        >
          {mode === 'file' ? 'Paste text instead' : 'Choose a file instead'}
        </button>
      </div>

      {mode === 'file' ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'rounded border border-dashed p-3 transition-colors',
            dragging ? 'border-accent bg-accent/10' : 'border-line-soft bg-surface',
          )}
        >
          <input
            ref={picker}
            type="file"
            accept={accept}
            className="sr-only"
            aria-label={label}
            onChange={(event) => void take(event.target.files?.[0])}
          />

          {value !== '' ? (
            <div className="flex items-center gap-2">
              <FileCheck2 className="size-4 shrink-0 text-state-unchanged" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs text-ink">
                {filename ?? 'Loaded'}
              </span>
              <Button variant="ghost" size="sm" onClick={clear} aria-label={`Remove ${label}`}>
                <X className="size-3.5" aria-hidden />
                Remove
              </Button>
            </div>
          ) : (
            /*
             * A real button, not a div with an onClick. It is the only thing
             * here a keyboard can reach — dropping a file is a pointer gesture
             * with no keyboard equivalent, so the browse path is not a
             * convenience, it is the accessible one.
             */
            <button
              type="button"
              onClick={() => picker.current?.click()}
              className="flex w-full flex-col items-center gap-1 rounded py-2 text-center"
            >
              <Upload className="size-5 text-ink-faint" aria-hidden />
              <span className="text-xs text-ink">
                Drop the file here, or <span className="text-accent">browse</span>
              </span>
              <span className="text-2xs text-ink-faint">{accept.split(',').join(' · ')}</span>
            </button>
          )}
        </div>
      ) : (
        <Textarea
          rows={5}
          className="font-mono text-2xs"
          placeholder={placeholder}
          value={value}
          onChange={(event) => {
            setFilename(null);
            onChange(event.target.value);
          }}
          aria-label={label}
        />
      )}

      {problem !== null && (
        <p role="alert" className="text-2xs text-state-failed">
          {problem}
        </p>
      )}

      {constraints.length > 0 && (
        <ul className="space-y-0.5">
          {constraints.map((line) => (
            <li key={line} className="flex gap-1.5 text-2xs text-ink-faint">
              <span aria-hidden>·</span>
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
