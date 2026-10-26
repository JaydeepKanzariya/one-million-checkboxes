import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createBoardEngine } from './engine/boardEngine.js';
import { EngineContext } from './useEngine.js';
import './styles/tokens.css';
import './styles/app.css';

// One engine per page: it owns the socket and the canvases, so it lives outside React.
// No StrictMode: its double-mount in development would open and close the socket twice.
const engine = createBoardEngine();

createRoot(document.getElementById('root')).render(
  <EngineContext.Provider value={engine}>
    <App />
  </EngineContext.Provider>,
);
