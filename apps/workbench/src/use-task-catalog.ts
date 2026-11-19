import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutomationType, AutomationItem } from '../../../packages/kernel/automation.ts';
import { rpc } from './client.ts';

type Definitions = {
  types: AutomationType[];
  unavailable: string[];
  sources?: { id: string; label: string }[];
};
type Instances = { types: { id: string; items: AutomationItem[] }[]; unavailable: string[] };
export function useTaskCatalog(only?: string) {
  const [catalog, setCatalog] = useState<Definitions>({ types: [], unavailable: [] });
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const definitions = useRef<Promise<Definitions>>(undefined);
  const ticket = useRef(0);
  const load = useCallback(
    async (invalidate = false) => {
      const current = ++ticket.current;
      if (invalidate) definitions.current = undefined;
      try {
        const description = (definitions.current ??= rpc<Definitions>('automation.types', {
          type: only,
        }));
        const [spec, status] = await Promise.all([
          description,
          rpc<Instances>('automation.instances', { type: only }),
        ]);
        const rows = new Map(status.types.map((t) => [t.id, t.items]));
        const value = {
          ...spec,
          types: spec.types.map((type) => ({ ...type, items: rows.get(type.id) ?? [] })),
          unavailable: [...new Set([...spec.unavailable, ...status.unavailable])],
        };
        if (current === ticket.current) {
          if (spec.unavailable.length) definitions.current = undefined;
          setCatalog(value);
          setReady(true);
          setError('');
        }
        return value;
      } catch (e) {
        if (current === ticket.current) {
          definitions.current = undefined;
          setReady(true);
          setError((e as Error).message);
        }
      }
    },
    [only],
  );
  useEffect(() => {
    setReady(false);
    void load(true);
    let timer: ReturnType<typeof setTimeout> | undefined,
      schema = false;
    const update = (event: Event) => {
      const kind = (event as CustomEvent).detail.type;
      const changed =
        /^(plugins\.|capabilities\.|inference\.|binding\.|conversations?\.(created|updated|deleted)|characters\.updated|mail\.updated|review\.sources|observation\.tasks\.changed)/.test(
          kind,
        );
      if (
        !changed &&
        !/^(automation\.|scheduler\.|review\.|care\.|observation\.|delegation\.|work\.|run\.(started|completed)|interaction\.)/.test(
          kind,
        )
      )
        return;
      schema ||= changed;
      timer ??= setTimeout(() => {
        timer = undefined;
        const refresh = schema;
        schema = false;
        void load(refresh);
      }, 180);
    };
    window.addEventListener('echo-event', update);
    return () => {
      ticket.current++;
      clearTimeout(timer);
      window.removeEventListener('echo-event', update);
    };
  }, [load]);
  return { catalog, load, error, ready };
}
