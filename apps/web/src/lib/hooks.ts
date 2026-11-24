import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useApiData<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mounted = useRef(true);

  const load = useCallback(async (silent = false): Promise<T | null> => {
    if (!silent) {
      setState((current) => ({ ...current, loading: true, error: null }));
    }
    try {
      const data = await loaderRef.current();
      if (mounted.current) setState({ data, loading: false, error: null });
      return data;
    } catch (error) {
      if (mounted.current) {
        setState((current) => ({
          data: current.data,
          loading: false,
          error: errorMessage(error),
        }));
      }
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
    // The caller owns the dependency list for this resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const setData = useCallback((updater: (current: T | null) => T | null) => {
    setState((current) => ({ ...current, data: updater(current.data) }));
  }, []);

  return { ...state, reload: load, setData };
}

export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/**
 * Page number for a filtered list, reset to the first page when the filters
 * change.
 *
 * This used to be `useState(1)` plus an effect that called `setPage(1)` on
 * every filter change: the list rendered the old page number once and then
 * corrected itself. Storing the filter key next to the page turns the reset
 * into a calculation, so the first render after a filter change is already
 * page one.
 */
export function useFilteredPage(filterKey: string): [number, (page: number) => void] {
  const [state, setState] = useState({ key: filterKey, page: 1 });

  const setPage = useCallback(
    (page: number) => setState({ key: filterKey, page }),
    [filterKey]
  );

  return [state.key === filterKey ? state.page : 1, setPage];
}

export function useInterval(callback: () => void, delay: number | null): void {
  const saved = useRef(callback);

  // Recorded in an effect, not while rendering: a ref written during render is
  // one of the things concurrent rendering makes unsafe.
  useEffect(() => {
    saved.current = callback;
  });

  useEffect(() => {
    if (delay === null) return;
    const timer = window.setInterval(() => saved.current(), delay);
    return () => window.clearInterval(timer);
  }, [delay]);
}
