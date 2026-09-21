import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App.js';
import '@xyflow/react/dist/style.css';
import './theme/tokens.css';
import './theme/app.css';
import './theme/xyflow-overrides.css';

const host = document.getElementById('root');
if (!host) throw new Error('index.html is missing #root');
createRoot(host).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
