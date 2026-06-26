import { useSearchParams, Link } from 'react-router-dom';
import { useMovements } from '../lib/queries.ts';
import { Spinner, ErrorMsg } from '../components/ui.tsx';
import type { EntityType, MovementAction } from '../../shared/types.ts';

const ACTION_LABEL: Record<MovementAction, string> = {
  created: 'Created',
  moved_in: 'Moved in',
  moved_out: 'Taken out',
  relocated: 'Relocated',
  edited: 'Edited',
  tagged: 'Tagged',
  untagged: 'Untagged',
  retired: 'Retired',
};

export function MovementsPage() {
  const [params] = useSearchParams();
  const entity_type = (params.get('entity_type') as EntityType | null) ?? undefined;
  const entity_id = params.get('entity_id') ? Number(params.get('entity_id')) : undefined;
  const movements = useMovements({ entity_type, entity_id, limit: 300 });
  const scoped = entity_type && entity_id;

  return (
    <div className="col">
      <div className="row">
        <h2 style={{ margin: 0 }} className="grow">
          History
        </h2>
        {scoped && (
          <Link className="small" to={entity_type === 'item' ? `/items/${entity_id}` : `/places/${entity_id}`}>
            ‹ Back
          </Link>
        )}
      </div>
      {scoped && (
        <p className="small muted">
          {entity_type} #{entity_id}
        </p>
      )}

      {movements.isLoading && <Spinner />}
      <ErrorMsg error={movements.error} />
      {movements.data?.length === 0 && <p className="muted">No history yet.</p>}

      {movements.data?.map((m) => (
        <div key={m.id} className="list-item" style={{ alignItems: 'flex-start' }}>
          <span className="grow">
            <div>
              <b>{ACTION_LABEL[m.action]}</b>{' '}
              {!scoped && (
                <Link
                  to={m.entity_type === 'item' ? `/items/${m.entity_id}` : `/places/${m.entity_id}`}
                  className="small"
                >
                  {m.entity_type} #{m.entity_id}
                </Link>
              )}
            </div>
            <div className="small muted">
              {m.from_place_id != null || m.to_place_id != null ? (
                <>
                  {m.from_place_id != null ? `place #${m.from_place_id}` : 'out'} →{' '}
                  {m.to_place_id != null ? `place #${m.to_place_id}` : 'out'} ·{' '}
                </>
              ) : null}
              {m.method} · {m.at}
            </div>
          </span>
        </div>
      ))}
    </div>
  );
}
