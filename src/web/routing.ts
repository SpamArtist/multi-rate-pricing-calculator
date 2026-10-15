import React from 'react';

type Route = { kind: 'dashboard' } | { kind: 'new' } | { kind: 'document'; id: string };
const ROUTE_REPLACED = 'pricing:route-replaced';

function routeFromHash(): Route {
  const match = /^#\/documents(?:\/([^/?#]+))?$/.exec(window.location.hash);
  if (!match?.[1]) return { kind: 'dashboard' };
  if (match[1] === 'new') return { kind: 'new' };
  return { kind: 'document', id: decodeURIComponent(match[1]) };
}

export function useRoute(): Route & { key: number } {
  const [route, setRoute] = React.useState(() => ({ ...routeFromHash(), key: 0 }));
  React.useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', '#/documents');
    const sync = (event: Event): void => setRoute(current => ({
      ...routeFromHash(),
      key: event.type === ROUTE_REPLACED ? current.key : current.key + 1,
    }));
    window.addEventListener('hashchange', sync);
    window.addEventListener(ROUTE_REPLACED, sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener(ROUTE_REPLACED, sync);
    };
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.location.hash = path;
}

/** Update the current page's URL without starting a new page/editor session. */
export function replaceRoute(path: string): void {
  if (window.location.hash === `#${path}`) return;
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event(ROUTE_REPLACED));
}
