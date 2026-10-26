import { useEffect, useRef } from 'react';
import { Footer } from './components/Footer.jsx';
import { Header } from './components/Header.jsx';
import { MapPanel } from './components/MapPanel.jsx';
import { MobileSheet } from './components/MobileSheet.jsx';
import { Announcer, HintCard, Toast } from './components/Overlays.jsx';
import { SignInDialog } from './components/SignInDialog.jsx';
import { Toolbar } from './components/Toolbar.jsx';
import { useEngine } from './useEngine.js';

export function App() {
  const engine = useEngine();
  const canvasRef = useRef(null);
  const minimapRef = useRef(null);

  useEffect(() => engine.mount(canvasRef.current, minimapRef.current), [engine]);

  return (
    <div className="app-shell">
      <Header />
      <main className="stage">
        <canvas
          ref={canvasRef}
          className="board-canvas"
          role="grid"
          tabIndex={0}
          aria-label="One Million Checkboxes grid, 1,000 rows by 1,000 columns. Use arrow keys to move focus and Space or Enter to toggle."
        />
        <div className="scanlines" aria-hidden="true" />
        <Toolbar />
        <MapPanel canvasRef={minimapRef} />
        <HintCard />
        <MobileSheet />
        <Toast />
        <Announcer />
      </main>
      <Footer />
      <SignInDialog />
    </div>
  );
}
