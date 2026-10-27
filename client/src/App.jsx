import { Announcer, Toast } from './components/Overlays.jsx';
import { SignInDialog } from './components/SignInDialog.jsx';
import { GridPage } from './pages/GridPage.jsx';
import { Landing } from './pages/Landing.jsx';
import { useRoute } from './router.js';

export function App() {
  const route = useRoute();

  return (
    <>
      {route === '/grid' ? (
        <GridPage />
      ) : (
        <>
          <Landing />
          <Toast />
          <Announcer />
        </>
      )}
      <SignInDialog />
    </>
  );
}
