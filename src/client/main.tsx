import { createRoot } from 'react-dom/client';
import './style.css';

function Foundation() {
  return (
    <main>
      <p className="eyebrow">Reflection · Milestone 1</p>
      <h1>A foundation for reflection.</h1>
      <p>
        This local development build verifies card drawing, reading plans, and guarded publication
        using synthetic data.
      </p>
      <p>Personal readings and sign-in will become available in a later milestone.</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<Foundation />);
