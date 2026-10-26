import { useBoard, useEngine } from '../useEngine.js';
import { FitIcon, MinusIcon, PlusIcon, TargetIcon } from './icons.jsx';

export function Toolbar() {
  const engine = useEngine();
  const findAvailable = useBoard((s) => s.findAvailable);

  return (
    <div className="toolbar" aria-label="Board navigation">
      <button type="button" className="btn btn-icon" aria-label="Zoom out" title="Zoom out (-)" onClick={engine.zoomOut}>
        <MinusIcon />
      </button>
      <button type="button" className="btn btn-ghost" title="Fit whole sheet (0)" onClick={engine.fit}>
        <FitIcon />
        Fit
      </button>
      <button type="button" className="btn btn-icon" aria-label="Zoom in" title="Zoom in (+)" onClick={engine.zoomIn}>
        <PlusIcon />
      </button>
      <span className="toolbar-divider desktop-only" aria-hidden="true" />
      <button
        type="button"
        className="btn btn-ghost desktop-only"
        disabled={!findAvailable}
        title={findAvailable ? 'Jump to recent activity' : 'No one has checked a box in the last minute'}
        onClick={engine.findActivity}
      >
        <TargetIcon />
        Find activity
      </button>
    </div>
  );
}
