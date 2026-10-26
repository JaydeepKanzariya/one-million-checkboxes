import { useState } from 'react';
import { MinusIcon } from './icons.jsx';

const startsCollapsed = () => window.matchMedia('(max-width: 640px)').matches;

// The minimap canvas stays mounted while collapsed, because the engine keeps drawing to it.
export function MapPanel({ canvasRef }) {
  const [collapsed, setCollapsed] = useState(startsCollapsed);

  return (
    <aside className={`map${collapsed ? ' collapsed' : ''}`} aria-label="Map">
      {collapsed && (
        <button type="button" className="btn btn-ghost map-pill" onClick={() => setCollapsed(false)}>
          Map
        </button>
      )}
      <div className="map-panel" hidden={collapsed}>
        <div className="map-header">
          <span>Map</span>
          <button type="button" className="map-collapse" aria-label="Collapse map" onClick={() => setCollapsed(true)}>
            <MinusIcon />
          </button>
        </div>
        <canvas ref={canvasRef} className="map-canvas" width="200" height="200" />
      </div>
    </aside>
  );
}
