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

export function useInterval(callback: () => void, delay: number | null): void {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    if (delay === null) return;
    const timer = window.setInterval(() => saved.current(), delay);
    return () => window.clearInterval(timer);
  }, [delay]);
}
