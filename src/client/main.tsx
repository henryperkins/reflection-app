import { createRoot } from 'react-dom/client';
import { IdentityApp } from './identity.tsx';
import './style.css';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<IdentityApp />);
