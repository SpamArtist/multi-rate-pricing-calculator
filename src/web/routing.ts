import React from 'react';

type Route = { kind: 'dashboard' } | { kind: 'new' } | { kind: 'document'; id: string };

function routeFromHash(): Route {
  const match = /^#\/documents(?:\/([^/?#]+))?$/.exec(window.location.hash);
  if (!match?.[1]) return { kind: 'dashboard' };
  if (match[1] === 'new') return { kind: 'new' };
  return { kind: 'document', id: decodeURIComponent(match[1]) };
}

export function useRoute(): Route {
  const [route, setRoute] = React.useState<Route>(routeFromHash);
  React.useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', '#/documents');
    const sync = (): void => setRoute(routeFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.location.hash = path;
}
