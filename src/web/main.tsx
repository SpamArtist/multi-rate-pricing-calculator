import React from 'react';
import { createRoot } from 'react-dom/client';

function App(): React.JSX.Element {
  const [status, setStatus] = React.useState('Not checked');

  async function checkService(): Promise<void> {
    setStatus('Checking service…');
    try {
      const response = await fetch('/health');
      if (!response.ok) throw new Error('Health check failed');
      const health: { database: string } = await response.json();
      setStatus(health.database === 'ok' ? 'Database connected' : 'Database unavailable');
    } catch {
      setStatus('Service unavailable');
    }
  }

  return (
    <main>
      <h1>Pricing documents</h1>
      <p>Production app checks run against the API and PostgreSQL.</p>
      <button type="button" onClick={checkService}>Check service</button>
      <p role="status" aria-live="polite">{status}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
