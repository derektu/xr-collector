import { useEffect } from 'react';

export function useTitle(text: string, enabled: boolean): void {
  if (enabled) useEffect(() => { document.title = text; }, []);
}
